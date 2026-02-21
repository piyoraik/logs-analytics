import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CastEvent } from '../fflogs/types';

export interface XivApiAbilityResolverOptions {
  enabled: boolean;
  baseUrl: string;
  language: string;
  cachePath: string;
  maxRetries?: number;
  timeoutMs?: number;
  concurrency?: number;
}

export interface XivApiResolveStats {
  uniqueAbilityIds: number;
  alreadyKnown: number;
  cacheHit: number;
  fetched: number;
  resolved: number;
  notResolved: number;
  requestFailures: number;
  parseFailures: number;
  failedIds: number[];
  skippedDueToConnectivity?: boolean;
}

export interface XivApiResolveResult {
  resolved: Map<number, string>;
  stats: XivApiResolveStats;
}

export interface ResolveMissingOptions {
  includeKnown?: boolean;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function toAbilityId(event: CastEvent): number | null {
  const id = event.abilityGameID ?? event.ability?.gameID ?? event.ability?.guid;
  return typeof id === 'number' && Number.isFinite(id) && id > 0 ? id : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractStringName(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    for (const key of ['ja', 'en', 'de', 'fr']) {
      const nested = rec[key];
      if (typeof nested === 'string' && nested.trim().length > 0) {
        return nested.trim();
      }
    }
  }
  return null;
}

function parseAbilityNameFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const root = payload as Record<string, unknown>;
  const directCandidates = [
    root.Name,
    root.name,
    (root.fields as Record<string, unknown> | undefined)?.Name,
    (root.Fields as Record<string, unknown> | undefined)?.Name,
    (root.data as Record<string, unknown> | undefined)?.Name,
    (root.data as Record<string, unknown> | undefined)?.name,
    (root.row as Record<string, unknown> | undefined)?.Name,
    ((root.row as Record<string, unknown> | undefined)?.fields as Record<string, unknown> | undefined)?.Name,
    ((root.results as Array<Record<string, unknown>> | undefined)?.[0] as Record<string, unknown> | undefined)?.Name,
    ((root.Results as Array<Record<string, unknown>> | undefined)?.[0] as Record<string, unknown> | undefined)?.Name
  ];

  for (const candidate of directCandidates) {
    const name = extractStringName(candidate);
    if (name) {
      return name;
    }
  }

  return null;
}

type FetchResult = { kind: 'ok'; payload: unknown } | { kind: 'fail'; reason: 'request' | 'parse' | 'notfound' };

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        Accept: 'application/json'
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithRetry(url: string, maxRetries: number, timeoutMs: number): Promise<FetchResult> {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, timeoutMs);

      if (response.status === 404) {
        return { kind: 'fail', reason: 'notfound' };
      }

      if ((response.status === 429 || response.status >= 500) && attempt <= maxRetries) {
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }

      if (!response.ok) {
        return { kind: 'fail', reason: 'request' };
      }

      try {
        return { kind: 'ok', payload: (await response.json()) as unknown };
      } catch {
        return { kind: 'fail', reason: 'parse' };
      }
    } catch {
      if (attempt > maxRetries) {
        return { kind: 'fail', reason: 'request' };
      }
      await sleep(250 * 2 ** (attempt - 1));
    }
  }
  return { kind: 'fail', reason: 'request' };
}

export class XivApiAbilityResolver {
  private readonly options: XivApiAbilityResolverOptions;

  private readonly cache = new Map<number, string>();

  private loaded = false;

  constructor(options: XivApiAbilityResolverOptions) {
    this.options = {
      ...options,
      baseUrl: normalizeBaseUrl(options.baseUrl),
      maxRetries: options.maxRetries ?? 2,
      timeoutMs: options.timeoutMs ?? 2500,
      concurrency: options.concurrency ?? 8
    };
  }

  private async loadCacheIfNeeded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;

    try {
      const raw = await readFile(this.options.cachePath, 'utf-8');
      const json = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(json)) {
        const id = Number(k);
        if (Number.isFinite(id) && typeof v === 'string' && v.length > 0) {
          this.cache.set(id, v);
        }
      }
    } catch {
      // no cache yet
    }
  }

  private async persistCache(): Promise<void> {
    const dir = path.dirname(this.options.cachePath);
    await mkdir(dir, { recursive: true });

    const json: Record<string, string> = {};
    for (const [id, name] of this.cache.entries()) {
      json[String(id)] = name;
    }

    await writeFile(this.options.cachePath, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
  }

  private buildUrls(abilityId: number): string[] {
    const lang = encodeURIComponent(this.options.language);
    const base = this.options.baseUrl;

    return [
      `${base}/Action/${abilityId}?columns=Name&language=${lang}`,
      `${base}/Action/${abilityId}?language=${lang}`,
      `${base}/api/sheet/Action/${abilityId}?fields=Name&language=${lang}`
    ];
  }

  private buildSheetUrls(sheet: string, abilityId: number): string[] {
    const lang = encodeURIComponent(this.options.language);
    const base = this.options.baseUrl;
    return [
      `${base}/api/sheet/${sheet}/${abilityId}?fields=Name&language=${lang}`,
      `${base}/${sheet}/${abilityId}?columns=Name&language=${lang}`
    ];
  }

  private candidateIds(rawId: number): number[] {
    const ids = new Set<number>([rawId]);
    if (rawId >= 1_000_000) {
      const mod1m = rawId % 1_000_000;
      if (mod1m > 0) {
        ids.add(mod1m);
      }
      const mod100k = rawId % 100_000;
      if (mod100k > 0) {
        ids.add(mod100k);
      }
    }
    return [...ids];
  }

  private async resolveSingle(
    abilityId: number,
    stats: Pick<XivApiResolveStats, 'requestFailures' | 'parseFailures'>
  ): Promise<string | null> {
    const candidates = this.candidateIds(abilityId);
    const extraSheets = ['GeneralAction', 'PetAction', 'BuddyAction', 'CraftAction', 'PvPAction'];
    for (const id of candidates) {
      const primaryUrls = this.buildUrls(id);
      for (const url of primaryUrls) {
        const fetchResult = await fetchJsonWithRetry(
          url,
          this.options.maxRetries ?? 2,
          this.options.timeoutMs ?? 2500
        );
        if (fetchResult.kind !== 'ok') {
          if (fetchResult.reason === 'request') {
            stats.requestFailures += 1;
          } else if (fetchResult.reason === 'parse') {
            stats.parseFailures += 1;
          }
          continue;
        }
        const name = parseAbilityNameFromPayload(fetchResult.payload);
        if (name) {
          return name;
        }
      }

      for (const sheet of extraSheets) {
        const urls = this.buildSheetUrls(sheet, id);
        for (const url of urls) {
          const fetchResult = await fetchJsonWithRetry(
            url,
            this.options.maxRetries ?? 2,
            this.options.timeoutMs ?? 2500
          );
          if (fetchResult.kind !== 'ok') {
            if (fetchResult.reason === 'request') {
              stats.requestFailures += 1;
            } else if (fetchResult.reason === 'parse') {
              stats.parseFailures += 1;
            }
            continue;
          }
          const name = parseAbilityNameFromPayload(fetchResult.payload);
          if (name) {
            return name;
          }
        }
      }
    }
    return null;
  }

  async resolveMissing(
    events: CastEvent[],
    alreadyKnown: Map<number, string>,
    options?: ResolveMissingOptions
  ): Promise<XivApiResolveResult> {
    const resolved = new Map<number, string>();
    const stats: XivApiResolveStats = {
      uniqueAbilityIds: 0,
      alreadyKnown: 0,
      cacheHit: 0,
      fetched: 0,
      resolved: 0,
      notResolved: 0,
      requestFailures: 0,
      parseFailures: 0,
      failedIds: []
    };

    if (!this.options.enabled) {
      return { resolved, stats };
    }

    await this.loadCacheIfNeeded();

    const wanted = new Set<number>();
    const uniqueAll = new Set<number>();
    for (const event of events) {
      const id = toAbilityId(event);
      if (id == null) {
        continue;
      }
      uniqueAll.add(id);
      if (!options?.includeKnown && alreadyKnown.has(id)) {
        continue;
      }
      wanted.add(id);
    }
    stats.uniqueAbilityIds = uniqueAll.size;
    stats.alreadyKnown = uniqueAll.size - wanted.size;

    if (wanted.size === 0) {
      await this.persistCache();
      return { resolved, stats };
    }

    try {
      await fetchWithTimeout(`${this.options.baseUrl}/`, this.options.timeoutMs ?? 2500);
    } catch {
      stats.skippedDueToConnectivity = true;
      stats.notResolved = wanted.size;
      stats.failedIds = [...wanted].slice(0, 20);
      await this.persistCache();
      return { resolved, stats };
    }

    const unresolved: number[] = [];
    for (const id of wanted) {
      const cached = this.cache.get(id);
      if (cached) {
        resolved.set(id, cached);
        stats.cacheHit += 1;
        continue;
      }
      unresolved.push(id);
    }

    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, this.options.concurrency ?? 8) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= unresolved.length) {
          return;
        }
        const id = unresolved[index];

        stats.fetched += 1;
        const name = await this.resolveSingle(id, stats);
        if (!name) {
          stats.notResolved += 1;
          if (stats.failedIds.length < 20) {
            stats.failedIds.push(id);
          }
          continue;
        }
        this.cache.set(id, name);
        resolved.set(id, name);
        stats.resolved += 1;
      }
    });
    await Promise.all(workers);

    await this.persistCache();
    return { resolved, stats };
  }
}
