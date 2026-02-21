import { FFLogsGraphQLClient } from './client';
import { CHARACTER_RANKINGS_QUERY, CHARACTER_RANKINGS_QUERY_METRIC_ONLY, WORLD_ZONES_QUERY } from './queries';
import { EncounterCandidate, EncounterGroup, RankingEntry, RankingsResult } from './types';
import { getReportFights } from './report';

interface RankingsQueryData {
  worldData: {
    encounter: {
      characterRankings: any;
    } | null;
  };
}

interface ZonesQueryData {
  worldData: {
    zones: Array<{
      id: number;
      name: string;
      encounters: Array<{ id: number; name: string }>;
    }>;
  };
}

function mapDifficultyForRankings(difficulty?: number): number | undefined {
  if (!Number.isFinite(difficulty)) {
    return undefined;
  }
  switch (difficulty) {
    case 101:
      return 5;
    case 100:
      return 4;
    case 102:
      return 6;
    default:
      return difficulty;
  }
}

export interface RankingsParams {
  encounterID: number;
  metric: string;
  difficulty?: number;
  pageSize?: number;
  rankIndex: number;
  region?: string;
  server?: string;
  className?: string;
  specName?: string;
  partition?: number;
}

function matchesJobFilter(entry: RankingEntry, job?: string): boolean {
  const aliases: Record<string, string> = {
    pld: 'paladin',
    war: 'warrior',
    drk: 'darkknight',
    gnb: 'gunbreaker',
    whm: 'whitemage',
    sch: 'scholar',
    ast: 'astrologian',
    sge: 'sage',
    mnk: 'monk',
    drg: 'dragoon',
    nin: 'ninja',
    sam: 'samurai',
    rpr: 'reaper',
    vpr: 'viper',
    brd: 'bard',
    mch: 'machinist',
    dnc: 'dancer',
    blm: 'blackmage',
    smn: 'summoner',
    rdm: 'redmage',
    pct: 'pictomancer'
  };
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const canonicalToClassId: Record<string, string> = {
    paladin: '19',
    warrior: '21',
    darkknight: '32',
    gunbreaker: '37',
    whitemage: '24',
    scholar: '28',
    astrologian: '33',
    sage: '40',
    monk: '20',
    dragoon: '22',
    ninja: '30',
    samurai: '34',
    reaper: '39',
    viper: '41',
    bard: '23',
    machinist: '31',
    dancer: '38',
    blackmage: '25',
    summoner: '27',
    redmage: '35',
    pictomancer: '42'
  };
  const qRaw = normalize(String(job ?? '').trim());
  const q = aliases[qRaw] ?? qRaw;
  if (!q) return true;
  const c = normalize(String(entry.className ?? ''));
  const s = normalize(String(entry.specName ?? ''));
  const targetClassId = canonicalToClassId[q];
  return (
    c === q ||
    s === q ||
    c.includes(q) ||
    s.includes(q) ||
    (targetClassId != null && c === targetClassId)
  );
}

function scoreForSort(entry: RankingEntry): number {
  const a = Number.isFinite(entry.highestRdps) ? (entry.highestRdps as number) : Number(entry.amount ?? 0);
  return Number.isFinite(a) ? a : 0;
}

function normalizeAndSortRankings(entries: RankingEntry[], params: RankingsParams): RankingEntry[] {
  const filtered = entries.filter((e) => matchesJobFilter(e, params.className ?? params.specName));
  filtered.sort((a, b) => {
    const ra = Number.isFinite(a.rank) ? Number(a.rank) : Number.POSITIVE_INFINITY;
    const rb = Number.isFinite(b.rank) ? Number(b.rank) : Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    const sa = scoreForSort(a);
    const sb = scoreForSort(b);
    if (sa !== sb) return sb - sa;
    const pa = Number.isFinite(a.bestPercent) ? (a.bestPercent as number) : -1;
    const pb = Number.isFinite(b.bestPercent) ? (b.bestPercent as number) : -1;
    if (pa !== pb) return pb - pa;
    return 0;
  });
  return filtered;
}

function parseFightId(raw: any): number | null {
  const value = raw?.fightID ?? raw?.fightId ?? raw?.fight ?? raw?.encounterFightID ?? raw?.encounterFightId;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseReportCode(raw: any): string | null {
  if (raw?.report && typeof raw.report === 'object') {
    const nestedCode =
      raw.report.code ??
      raw.report.reportCode ??
      raw.report.id ??
      raw.report.reportID;
    if (typeof nestedCode === 'string' && /^[A-Za-z0-9]{8,}$/.test(nestedCode.trim())) {
      return nestedCode.trim();
    }
  }

  const direct =
    raw?.report?.code ??
    raw?.reportCode ??
    raw?.code ??
    raw?.report?.reportCode ??
    (typeof raw?.report === 'string' ? raw.report : undefined) ??
    (typeof raw?.reportURL === 'string' ? raw.reportURL : undefined) ??
    (typeof raw?.reportUrl === 'string' ? raw.reportUrl : undefined) ??
    (typeof raw?.url === 'string' ? raw.url : undefined);

  if (typeof direct === 'string') {
    const s = direct.trim();
    if (!s) {
      return null;
    }
    const m = s.match(/\/reports\/([A-Za-z0-9]+)/i);
    if (m?.[1]) {
      return m[1];
    }
    if (/^[A-Za-z0-9]{8,}$/.test(s)) {
      return s;
    }
  }

  return null;
}

function normalizeRanking(raw: any): RankingEntry | null {
  const reportCode = parseReportCode(raw);
  const fightID = parseFightId(raw);
  if (!reportCode || fightID == null) {
    return null;
  }
  const m = metricFields(raw);

  return {
    rank: Number(raw.rank ?? 0),
    amount: Number(raw.amount ?? 0),
    reportCode,
    fightID,
    bestPercent: m.bestPercent,
    highestRdps: m.highestRdps,
    kill: m.kill,
    fastestSec: m.fastestSec,
    medianRdps: m.medianRdps,
    characterName: raw.character?.name ?? raw.name,
    serverName: raw.character?.server?.name ?? raw.server,
    region: raw.character?.server?.region?.slug,
    className: raw.character?.classID ? String(raw.character.classID) : raw.class ? String(raw.class) : undefined,
    specName: raw.character?.spec ? String(raw.character.spec) : raw.spec ? String(raw.spec) : undefined
  };
}

function readPath(obj: any, path: string): any {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function readPathCI(obj: any, path: string): any {
  const parts = path.split('.');
  let cur = obj;
  for (const rawPart of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(cur, rawPart)) {
      cur = cur[rawPart];
      continue;
    }
    const part = rawPart.toLowerCase();
    const key = Object.keys(cur).find((k) => k.toLowerCase() === part);
    if (!key) return undefined;
    cur = cur[key];
  }
  return cur;
}

function pickNumber(obj: any, paths: string[]): number | undefined {
  for (const p of paths) {
    const v = readPathCI(obj, p);
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v;
    }
    if (typeof v === 'string') {
      const n = Number(v.replace(/,/g, '').trim());
      if (Number.isFinite(n)) {
        return n;
      }
    }
  }
  return undefined;
}

function pickBoolean(obj: any, paths: string[]): boolean | undefined {
  for (const p of paths) {
    const v = readPathCI(obj, p);
    if (typeof v === 'boolean') {
      return v;
    }
    if (typeof v === 'number') {
      return v !== 0;
    }
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes') return true;
      if (s === 'false' || s === '0' || s === 'no') return false;
    }
  }
  return undefined;
}

function toSeconds(v?: number): number | undefined {
  if (!Number.isFinite(v)) return undefined;
  if ((v as number) > 10000) {
    return (v as number) / 1000;
  }
  return v;
}

function parseBracketData(raw: any): any {
  const bd = raw?.bracketData;
  if (!bd) return undefined;
  if (typeof bd === 'string') {
    try {
      return JSON.parse(bd);
    } catch {
      return undefined;
    }
  }
  return bd;
}

function metricFields(raw: any): {
  bestPercent?: number;
  highestRdps?: number;
  kill?: boolean;
  fastestSec?: number;
  medianRdps?: number;
} {
  const bd = parseBracketData(raw);
  const bestPercent =
    pickNumber(raw, ['rankPercent', 'percentile', 'bestPercent']) ??
    pickNumber(bd, ['rankPercent', 'percentile', 'bestPercent', 'historicalPercent']);
  const highestRdps =
    pickNumber(raw, ['rDPS', 'rdps', 'amount']) ??
    pickNumber(bd, ['rDPS.max', 'rdps.max', 'rDPS', 'rdps', 'max']);
  const kill = pickBoolean(raw, ['kill', 'isKill', 'success']) ?? pickBoolean(bd, ['kill', 'isKill', 'success']) ?? true;
  const fastestSec = toSeconds(
    pickNumber(raw, ['fastest', 'duration']) ??
      pickNumber(bd, ['fastest', 'duration.min', 'duration.fastest', 'minDuration'])
  );
  const medianRdps =
    pickNumber(raw, ['medianRdps', 'median']) ??
    pickNumber(bd, ['rDPS.median', 'rdps.median', 'rDPS.avg', 'rdps.avg', 'median']);
  return { bestPercent, highestRdps, kill, fastestSec, medianRdps };
}

function pickFightIdFromReport(
  fights: Array<{
    id: number;
    encounterID: number;
    startTime: number;
    endTime: number;
    kill: boolean;
  }>,
  encounterID: number,
  startTime?: number,
  duration?: number
): number | null {
  const candidates = fights.filter((f) => f.encounterID === encounterID);
  const pool = candidates.length > 0 ? candidates : fights;
  if (pool.length === 0) {
    return null;
  }
  if (!Number.isFinite(startTime)) {
    return pool.find((f) => f.kill)?.id ?? pool[0].id;
  }
  const targetStart = Number(startTime);
  const targetDuration = Number.isFinite(duration) ? Number(duration) : null;
  let best = pool[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const f of pool) {
    const ds = Math.abs(f.startTime - targetStart);
    const fd = f.endTime - f.startTime;
    const dd = targetDuration == null ? 0 : Math.abs(fd - targetDuration);
    const score = ds + dd;
    if (score < bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best.id;
}

function extractRankingsRows(payload: any): any[] {
  if (!payload) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload.rankings)) {
    return payload.rankings;
  }
  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  const queue: any[] = [payload];
  const visited = new Set<any>();
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || visited.has(node)) {
      continue;
    }
    visited.add(node);

    if (Array.isArray(node)) {
      if (
        node.length > 0 &&
        node.some((x) => x && typeof x === 'object' && ('fightID' in x || 'fightId' in x || 'report' in x))
      ) {
        return node;
      }
      for (const item of node) {
        queue.push(item);
      }
      continue;
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        if (
          value.length > 0 &&
          value.some((x) => x && typeof x === 'object' && ('fightID' in x || 'fightId' in x || 'report' in x))
        ) {
          return value;
        }
      }
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return [];
}

export async function getRankings(
  client: FFLogsGraphQLClient,
  params: RankingsParams
): Promise<RankingsResult> {
  const requestRankings = async (v: {
    encounterID: number;
    metric: string;
    difficulty?: number;
    size?: number;
    page?: number;
    partition?: number;
  }) => {
    const variables: Record<string, unknown> = {
      encounterID: v.encounterID,
      metric: v.metric
    };
    if (Number.isFinite(v.difficulty)) {
      variables.difficulty = v.difficulty;
    }
    if (Number.isFinite(v.size)) {
      variables.size = v.size;
    }
    if (Number.isFinite(v.page)) {
      variables.page = v.page;
    }
    if (typeof v.partition === 'number') {
      variables.partition = v.partition;
    }
    return client.request<RankingsQueryData>(CHARACTER_RANKINGS_QUERY, variables);
  };

  const requestRankingsMetricOnly = async (v: {
    encounterID: number;
    metric: string;
    size?: number;
    page?: number;
    partition?: number;
  }) => {
    const variables: Record<string, unknown> = {
      encounterID: v.encounterID,
      metric: v.metric
    };
    if (Number.isFinite(v.size)) {
      variables.size = v.size;
    }
    if (Number.isFinite(v.page)) {
      variables.page = v.page;
    }
    if (typeof v.partition === 'number') {
      variables.partition = v.partition;
    }
    return client.request<RankingsQueryData>(CHARACTER_RANKINGS_QUERY_METRIC_ONLY, variables);
  };

  const resolveRankingRows = async (rows: any[]): Promise<RankingEntry[]> => {
    const entries: RankingEntry[] = [];
    const unresolved: Array<{
      row: any;
      reportCode: string;
    }> = [];

    for (const row of rows) {
      const normalized = normalizeRanking(row);
      if (normalized) {
        entries.push(normalized);
        continue;
      }
      const reportCode = parseReportCode(row);
      if (!reportCode) {
        continue;
      }
      unresolved.push({ row, reportCode });
    }

    if (unresolved.length === 0) {
      return entries;
    }

    const uniqueCodes = [...new Set(unresolved.map((u) => u.reportCode))];
    const reportFightCache = new Map<string, Awaited<ReturnType<typeof getReportFights>>>();
    await Promise.all(
      uniqueCodes.map(async (code) => {
        try {
          const report = await getReportFights(client, code, { translate: false });
          reportFightCache.set(code, report);
        } catch {
          // ignore non-accessible reports
        }
      })
    );

    for (const item of unresolved) {
      const report = reportFightCache.get(item.reportCode);
      if (!report) {
        continue;
      }
      const m = metricFields(item.row);
      const inferredFightId = pickFightIdFromReport(
        report.fights,
        params.encounterID,
        typeof item.row?.startTime === 'number' ? item.row.startTime : undefined,
        typeof item.row?.duration === 'number' ? item.row.duration : undefined
      );
      if (inferredFightId == null) {
        continue;
      }
      entries.push({
        rank: Number(item.row?.rank ?? 0),
        amount: Number(item.row?.amount ?? 0),
        reportCode: item.reportCode,
        fightID: inferredFightId,
        bestPercent: m.bestPercent,
        highestRdps: m.highestRdps,
        kill: m.kill,
        fastestSec: m.fastestSec,
        medianRdps: m.medianRdps,
        characterName: item.row?.character?.name ?? item.row?.name,
        serverName: item.row?.character?.server?.name ?? item.row?.server,
        region: item.row?.character?.server?.region?.slug,
        className: item.row?.character?.classID
          ? String(item.row.character.classID)
          : item.row?.class
            ? String(item.row.class)
            : undefined,
        specName: item.row?.character?.spec
          ? String(item.row.character.spec)
          : item.row?.spec
            ? String(item.row.spec)
            : undefined
      });
    }

    return entries;
  };

  const safePageSize = Number.isFinite(params.pageSize as number)
    ? Math.max(1, Math.min(100, Number(params.pageSize)))
    : 10;
  const targetCount = Math.max(params.rankIndex + 1, safePageSize);
  const shouldScanWide = Boolean(params.className || params.specName);
  // Job filtering previously scanned too many pages and caused Lambda timeouts.
  // Use larger pages with fewer requests to keep execution under API/Lambda limits.
  const apiPageSize = shouldScanWide ? Math.max(50, safePageSize) : Math.max(10, safePageSize);
  const maxPages = shouldScanWide ? 4 : Math.max(2, Math.ceil(targetCount / apiPageSize) + 1);

  const collectPagedRows = async (
    seed: any[],
    fetchPage: (page: number) => Promise<RankingsQueryData>
  ): Promise<any[]> => {
    const all = [...seed];
    if (seed.length === 0) return all;
    if (seed.length < apiPageSize) return all;
    for (let page = 2; page <= maxPages; page += 1) {
      let next: RankingsQueryData;
      try {
        next = await fetchPage(page);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Unknown argument "page"')) {
          break;
        }
        throw error;
      }
      const rows = extractRankingsRows(next.worldData.encounter?.characterRankings);
      if (!rows.length) {
        break;
      }
      all.push(...rows);
      if (rows.length < apiPageSize) {
        break;
      }
      if (!shouldScanWide && all.length >= targetCount) {
        break;
      }
    }
    return all;
  };

  let data: RankingsQueryData;
  let useMetricOnly = false;
  let resolvedDifficulty = params.difficulty;
  try {
    data = await requestRankings({
      encounterID: params.encounterID,
      metric: params.metric,
      difficulty: params.difficulty,
      size: apiPageSize,
      partition: params.partition
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Invalid difficulty setting or size specified')) {
      throw error;
    }
    const mappedDifficulty = mapDifficultyForRankings(params.difficulty);
    if (mappedDifficulty !== params.difficulty) {
      try {
        data = await requestRankings({
          encounterID: params.encounterID,
          metric: params.metric,
          difficulty: mappedDifficulty,
          size: apiPageSize
        });
        resolvedDifficulty = mappedDifficulty;
      } catch {
        data = await requestRankingsMetricOnly({
          encounterID: params.encounterID,
          metric: params.metric,
          size: apiPageSize,
          partition: params.partition
        });
        useMetricOnly = true;
        resolvedDifficulty = undefined;
      }
    } else {
      data = await requestRankingsMetricOnly({
        encounterID: params.encounterID,
        metric: params.metric,
        size: apiPageSize,
        partition: params.partition
      });
      useMetricOnly = true;
      resolvedDifficulty = undefined;
    }
  }

  let rankingsRaw = extractRankingsRows(data.worldData.encounter?.characterRankings);
  if (rankingsRaw.length > 0) {
    rankingsRaw = await collectPagedRows(rankingsRaw, async (page) => {
      if (useMetricOnly) {
        return requestRankingsMetricOnly({
          encounterID: params.encounterID,
          metric: params.metric,
          size: apiPageSize,
          page,
          partition: params.partition
        });
      }
      return requestRankings({
        encounterID: params.encounterID,
        metric: params.metric,
        difficulty: resolvedDifficulty,
        size: apiPageSize,
        page,
        partition: params.partition
      });
    });
  }
  if (!rankingsRaw || rankingsRaw.length === 0) {
    const payload = data.worldData.encounter?.characterRankings;
    const shape = payload ? Object.keys(payload).slice(0, 20).join(', ') : 'null';
    const payloadError =
      payload && typeof payload === 'object'
        ? (payload.error ?? payload.message ?? payload.msg)
        : undefined;
    const reason = typeof payloadError === 'string' && payloadError.trim() ? ` detail=${payloadError}` : '';
    if (typeof payloadError === 'string' && payloadError.includes('Invalid difficulty setting or size specified')) {
      let relaxedRows: any[] = [];
      const mappedDifficulty = mapDifficultyForRankings(params.difficulty);
      if (mappedDifficulty !== params.difficulty) {
        try {
          const mapped = await requestRankings({
            encounterID: params.encounterID,
            metric: params.metric,
            difficulty: mappedDifficulty,
            size: apiPageSize
          });
          relaxedRows = extractRankingsRows(mapped.worldData.encounter?.characterRankings);
          if (relaxedRows.length > 0) {
            relaxedRows = await collectPagedRows(relaxedRows, (page) =>
              requestRankings({
                encounterID: params.encounterID,
                metric: params.metric,
                difficulty: mappedDifficulty,
                size: apiPageSize,
                page,
                partition: params.partition
              })
            );
          }
        } catch {
          // noop
        }
      }
      if (relaxedRows.length === 0) {
        const relaxed = await requestRankingsMetricOnly({
          encounterID: params.encounterID,
          metric: params.metric,
          size: apiPageSize,
          partition: params.partition
        });
        relaxedRows = extractRankingsRows(relaxed.worldData.encounter?.characterRankings);
        if (relaxedRows.length > 0) {
          relaxedRows = await collectPagedRows(relaxedRows, (page) =>
            requestRankingsMetricOnly({
              encounterID: params.encounterID,
              metric: params.metric,
              size: apiPageSize,
              page,
              partition: params.partition
            })
          );
        }
      }
      if (relaxedRows.length > 0) {
        const relaxedRankings = await resolveRankingRows(relaxedRows);
        if (relaxedRankings.length > 0) {
          if (params.rankIndex < 0 || params.rankIndex >= relaxedRankings.length) {
            throw new Error(
              `rank-index out of range. index=${params.rankIndex}, available=0..${relaxedRankings.length - 1}`
            );
          }
          const relaxedSorted = normalizeAndSortRankings(relaxedRankings, params);
          if (relaxedSorted.length === 0) {
            throw new Error(
              `Rankings not found for specified job filter. job=${params.className ?? params.specName ?? '-'}`
            );
          }
          if (params.rankIndex < 0 || params.rankIndex >= relaxedSorted.length) {
            throw new Error(
              `rank-index out of range. index=${params.rankIndex}, available=0..${relaxedSorted.length - 1}`
            );
          }
          const limited = relaxedSorted.slice(0, safePageSize);
          if (params.rankIndex < 0 || params.rankIndex >= limited.length) {
            throw new Error(
              `rank-index out of range. index=${params.rankIndex}, available=0..${limited.length - 1}`
            );
          }
          return {
            encounterID: params.encounterID,
            metric: params.metric,
            difficulty: params.difficulty,
            pageSize: safePageSize,
            rankIndex: params.rankIndex,
            filters: {
              region: params.region,
              server: params.server,
              className: params.className,
              specName: params.specName,
              partition: params.partition
            },
            rankings: limited
          };
        }
      }
    }
    throw new Error(
      `Rankings not found for given criteria. Check encounter/metric/difficulty/visibility.${reason} payloadKeys=[${shape}]`
    );
  }

  const rankings = normalizeAndSortRankings(await resolveRankingRows(rankingsRaw), params);

  if (rankings.length === 0) {
    const sample = rankingsRaw[0] && typeof rankingsRaw[0] === 'object' ? Object.keys(rankingsRaw[0]).slice(0, 20) : [];
    if (params.className || params.specName) {
      throw new Error(
        `No rankings matched job filter. job=${params.className ?? params.specName}. sampleKeys=[${sample.join(',')}]`
      );
    }
    throw new Error(`No usable ranking entries returned (missing reportCode/fightID). sampleKeys=[${sample.join(',')}]`);
  }

  if (params.rankIndex < 0 || params.rankIndex >= rankings.length) {
    throw new Error(`rank-index out of range. index=${params.rankIndex}, available=0..${rankings.length - 1}`);
  }

  const limited = rankings.slice(0, safePageSize);

  if (params.rankIndex < 0 || params.rankIndex >= limited.length) {
    throw new Error(`rank-index out of range. index=${params.rankIndex}, available=0..${limited.length - 1}`);
  }

  return {
    encounterID: params.encounterID,
    metric: params.metric,
    difficulty: params.difficulty,
    pageSize: safePageSize,
    rankIndex: params.rankIndex,
    filters: {
      region: params.region,
      server: params.server,
      className: params.className,
      specName: params.specName,
      partition: params.partition
    },
    rankings: limited
  };
}

export async function searchEncounters(
  client: FFLogsGraphQLClient,
  keyword: string,
  maxResults = 30
): Promise<EncounterCandidate[]> {
  const data = await client.request<ZonesQueryData>(WORLD_ZONES_QUERY, {});
  const k = keyword.trim().toLowerCase();
  if (!k) {
    return [];
  }

  const out: EncounterCandidate[] = [];
  for (const zone of data.worldData.zones ?? []) {
    for (const enc of zone.encounters ?? []) {
      if (!enc.name?.toLowerCase().includes(k) && !String(enc.id).includes(k)) {
        continue;
      }
      out.push({
        id: enc.id,
        name: enc.name,
        zoneId: zone.id,
        zoneName: zone.name
      });
      if (out.length >= maxResults) {
        return out;
      }
    }
  }

  return out;
}

export async function getEncounterGroups(client: FFLogsGraphQLClient): Promise<EncounterGroup[]> {
  const data = await client.request<ZonesQueryData>(WORLD_ZONES_QUERY, {});
  return (data.worldData.zones ?? []).map((zone) => ({
    zoneId: zone.id,
    zoneName: zone.name,
    encounters: (zone.encounters ?? []).map((e) => ({ id: e.id, name: e.name }))
  }));
}
