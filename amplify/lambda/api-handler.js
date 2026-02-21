'use strict';

const crypto = require('node:crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchGetCommand, PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { FFLogsGraphQLClient } = require('../dist/fflogs/client');
const { getReportFights, getReportActorMap, getAllCastEvents, getAllEvents } = require('../dist/fflogs/report');
const { getRankings, searchEncounters, getEncounterGroups } = require('../dist/fflogs/rankings');
const { pickFight } = require('../dist/select/pickFight');
const { buildBossTimeline } = require('../dist/timeline/bossTimeline');
const { buildPlayerCasts } = require('../dist/players/playerCasts');
const { buildPlayerSummary } = require('../dist/players/summary');

function buildCharacterContentsQueryString(includeRecentReports) {
  return `
query CharacterContents($name: String!, $serverSlug: String!, $serverRegion: String!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      name
      zoneRankings(size: 100, metric: dps, includePrivateLogs: true)
      ${
        includeRecentReports
          ? `recentReports(limit: 30) {
        data {
          code
          title
          startTime
        }
      }`
          : ''
      }
    }
  }
}`;
}

function buildCharacterContentsQueryEnum(region, includeRecentReports) {
  return `
query CharacterContents($name: String!, $serverSlug: String!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: ${region}) {
      name
      zoneRankings(size: 100, metric: dps, includePrivateLogs: true)
      ${
        includeRecentReports
          ? `recentReports(limit: 30) {
        data {
          code
          title
          startTime
        }
      }`
          : ''
      }
    }
  }
}`;
}

const FFLOGS_CHARACTER_EXISTS_QUERY_STRING = `
query CharacterExists($name: String!, $serverSlug: String!, $serverRegion: String!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      name
    }
  }
}`;

function buildFFLogsCharacterExistsQueryEnum(region) {
  return `
query CharacterExists($name: String!, $serverSlug: String!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: ${region}) {
      name
    }
  }
}`;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {
    removeUndefinedValues: true
  }
});

function makeClient(locale = 'ja') {
  const clientId = process.env.FFLOGS_CLIENT_ID;
  const clientSecret = process.env.FFLOGS_CLIENT_SECRET;
  const tokenUrl = process.env.FFLOGS_TOKEN_URL;
  const graphqlUrl = process.env.FFLOGS_GRAPHQL_URL;
  if (!clientId || !clientSecret || !tokenUrl || !graphqlUrl) {
    throw new Error('Missing FFLogs env vars.');
  }
  return new FFLogsGraphQLClient({
    clientId,
    clientSecret,
    tokenUrl,
    graphqlUrl,
    locale,
    maxRetries: 1,
    requestTimeoutMs: 6000
  });
}

function ok(body) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body)
  };
}

function err(statusCode, message) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error: message })
  };
}

function logInfo(event, payload) {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: 'info',
      event,
      ts: new Date().toISOString(),
      ...payload
    })
  );
}

function logError(event, payload, error) {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: 'error',
      event,
      ts: new Date().toISOString(),
      ...payload,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    })
  );
}

function normalizePath(rawPath, stageName) {
  let path = rawPath || '/';
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  if (!stageName) {
    return path;
  }
  const stagePrefix = `/${stageName}`;
  if (path === stagePrefix) {
    return '/';
  }
  if (path.startsWith(`${stagePrefix}/`)) {
    return path.slice(stagePrefix.length);
  }
  return path;
}

function toBool(v, def = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return def;
  return v.toLowerCase() === 'true';
}

function toOptionalNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeServerSlug(v) {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function normalizeRegion(v) {
  const s = String(v ?? '').trim().toUpperCase();
  if (s === 'JP' || s === 'EU' || s === 'US' || s === 'KR' || s === 'CN' || s === 'TW' || s === 'OC') {
    return s;
  }
  return '';
}

function serverSlugToName(slug) {
  return String(slug ?? '')
    .split('-')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

async function searchCharactersViaXivApi(name, serverSlug, limit) {
  const base = (process.env.XIVAPI_BASE_URL ?? 'https://xivapi.com').replace(/\/+$/, '');
  const baseCandidates = [...new Set([base, 'https://xivapi.com', 'https://v1.xivapi.com'])];
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const serverName = serverSlugToName(serverSlug);
  const serverCandidates = [...new Set([serverSlug, serverName, serverName.replace(/\s+/g, ''), ''].filter(Boolean))];
  const urls = [];
  for (const b of baseCandidates) {
    for (const server of serverCandidates) {
      urls.push(
        `${b}/character/search?name=${encodeURIComponent(name)}${
          server ? `&server=${encodeURIComponent(server)}` : ''
        }&limit=${safeLimit}`
      );
      urls.push(
        `${b}/api/search?indexes=Character&string=${encodeURIComponent(name)}${
          server ? `&filters=${encodeURIComponent(`Server=${server}`)}` : ''
        }&limit=${safeLimit}`
      );
    }
  }

  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) {
      continue;
    }
    const data = await res.json();
    const rows = Array.isArray(data?.Results)
      ? data.Results
      : Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data?.Pagination?.Results)
          ? data.Pagination.Results
          : [];
    if (rows.length === 0) {
      continue;
    }
    return rows
      .map((x) => ({
        name: String(x?.Name ?? x?.name ?? '').trim(),
        serverName: String(x?.Server ?? x?.world ?? '').trim(),
        serverSlug: normalizeServerSlug(x?.Server ?? x?.world ?? serverSlug),
        region: ''
      }))
      .filter((x) => x.name && x.serverSlug);
  }
  return [];
}

async function searchCharacterViaFFLogsExact(client, name, serverSlug, region) {
  const nameVariants = [...new Set([name.trim(), name.trim().toLowerCase()])].filter(Boolean);
  const serverVariants = [...new Set([serverSlug, normalizeServerSlug(serverSlugToName(serverSlug))])].filter(Boolean);
  const regionVariants = [...new Set([String(region).toUpperCase(), String(region).toLowerCase()])].filter(Boolean);

  for (const nv of nameVariants) {
    for (const sv of serverVariants) {
      for (const rv of regionVariants) {
        try {
          const data = await client.request(FFLOGS_CHARACTER_EXISTS_QUERY_STRING, {
            name: nv,
            serverSlug: sv,
            serverRegion: rv
          });
          const c = data?.characterData?.character;
          if (c?.name) {
            return [{ name: String(c.name), serverName: serverSlugToName(sv), serverSlug: sv, region: '' }];
          }
        } catch {
          // try next variant
        }
      }
    }
  }

  for (const nv of nameVariants) {
    for (const sv of serverVariants) {
      try {
        const data = await client.request(buildFFLogsCharacterExistsQueryEnum(String(region).toUpperCase()), {
          name: nv,
          serverSlug: sv
        });
        const c = data?.characterData?.character;
        if (c?.name) {
          return [{ name: String(c.name), serverName: serverSlugToName(sv), serverSlug: sv, region: '' }];
        }
      } catch {
        // ignore
      }
    }
  }
  return [];
}

function maybeParseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

function extractCharacterContents(zoneRankingsPayload) {
  const payload = maybeParseJson(zoneRankingsPayload);
  if (!payload) return [];
  const zones =
    (Array.isArray(payload.zones) && payload.zones) ||
    (Array.isArray(payload.data?.zones) && payload.data.zones) ||
    [];
  const out = [];
  for (const zone of zones) {
    const zoneId = Number(zone?.zoneID ?? zone?.id ?? 0);
    const zoneName = String(zone?.zoneName ?? zone?.name ?? '');
    const encounters = Array.isArray(zone?.encounters) ? zone.encounters : [];
    for (const enc of encounters) {
      const encounterId = Number(enc?.id ?? enc?.encounterID ?? 0);
      if (!Number.isFinite(encounterId) || encounterId <= 0) continue;
      out.push({
        zoneId: Number.isFinite(zoneId) ? zoneId : 0,
        zoneName,
        encounterId,
        encounterName: String(enc?.name ?? ''),
        bestPercent: Number(enc?.rankPercent ?? enc?.bestPercent ?? 0),
        totalKills: Number(enc?.totalKills ?? enc?.killCount ?? 0)
      });
    }
  }

  const map = new Map();
  for (const item of out) {
    const key = `${item.zoneId}:${item.encounterId}`;
    const prev = map.get(key);
    if (!prev || item.bestPercent > prev.bestPercent) {
      map.set(key, item);
    }
  }
  return [...map.values()].sort((a, b) => {
    if (a.zoneName !== b.zoneName) return a.zoneName.localeCompare(b.zoneName);
    return a.encounterName.localeCompare(b.encounterName);
  });
}

function normalizeAbilityName(v) {
  if (!v || typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

function extractIconPath(value) {
  if (!value) return undefined;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'object') {
    const candidates = [
      value.path_hr1,
      value.path_hr2,
      value.path,
      value.Path,
      value.href,
      value.Href,
      value.url,
      value.Url,
      value.icon,
      value.Icon
    ]
      .filter((x) => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean);
    for (const c of candidates) {
      if (c.includes('ui/icon/')) return c;
    }
    for (const c of candidates) {
      if (c.includes('/api/asset?path=') || c.startsWith('api/asset?path=')) return c;
    }
    for (const c of candidates) {
      if (c.endsWith('.tex') || c.endsWith('.png')) return c;
    }
  }
  return undefined;
}

function decodeAssetPath(pathOrUrl) {
  if (!pathOrUrl) return undefined;
  const marker = 'api/asset?path=';
  const idx = pathOrUrl.indexOf(marker);
  if (idx < 0) return undefined;
  const raw = pathOrUrl.slice(idx + marker.length);
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function buildAssetUrl(base, assetPath) {
  return `${base}/api/asset?path=${encodeURIComponent(assetPath)}&format=png`;
}

function toLegacyPngUrl(assetPath) {
  if (!assetPath || typeof assetPath !== 'string') return undefined;
  const normalized = assetPath.replace(/^\/+/, '');
  const m = normalized.match(/^ui\/icon\/(\d{6})\/(\d+)(?:_hr\d+)?\.(?:tex|png)$/i);
  if (!m) return undefined;
  return `https://xivapi.com/i/${m[1]}/${m[2]}.png`;
}

function toAbsoluteIconUrl(base, iconPathOrUrl) {
  if (!iconPathOrUrl) return undefined;
  const assetPath = decodeAssetPath(iconPathOrUrl);
  if (assetPath && assetPath.includes('ui/icon/')) {
    return toLegacyPngUrl(assetPath) ?? buildAssetUrl(base, assetPath);
  }
  if (/^https?:\/\//i.test(iconPathOrUrl)) {
    try {
      const u = new URL(iconPathOrUrl);
      if (u.pathname.includes('/api/asset')) {
        const p = u.searchParams.get('path');
        if (p && p.includes('ui/icon/')) {
          return toLegacyPngUrl(p) ?? buildAssetUrl(`${u.protocol}//${u.host}`, p);
        }
      }
      if (iconPathOrUrl.toLowerCase().endsWith('.tex')) {
        const p = u.pathname.replace(/^\/+/, '');
        return toLegacyPngUrl(p) ?? buildAssetUrl(`${u.protocol}//${u.host}`, p);
      }
      return iconPathOrUrl;
    } catch {
      return iconPathOrUrl;
    }
  }
  const normalized = iconPathOrUrl.trim();
  if (normalized === 'api/asset' || normalized === '/api/asset') {
    return undefined;
  }
  if (normalized.startsWith('api/asset?path=') || normalized.startsWith('/api/asset?path=')) {
    const ap = decodeAssetPath(normalized);
    if (!ap || !ap.includes('ui/icon/')) {
      return undefined;
    }
    return toLegacyPngUrl(ap) ?? buildAssetUrl(base, ap);
  }
  if (normalized.toLowerCase().endsWith('.tex')) {
    const assetPath = normalized.replace(/^\/+/, '');
    return toLegacyPngUrl(assetPath) ?? buildAssetUrl(base, assetPath);
  }
  return `${base}${normalized.startsWith('/') ? '' : '/'}${normalized}`;
}

function isValidIconUrl(iconUrl) {
  if (!iconUrl || typeof iconUrl !== 'string') return false;
  if (/^https:\/\/xivapi\.com\/i\/\d{6}\/\d+\.png$/i.test(iconUrl)) return true;
  if (!iconUrl.includes('/api/asset?path=')) return false;
  const m = iconUrl.match(/[?&]path=([^&]+)/);
  if (!m?.[1]) return false;
  try {
    const p = decodeURIComponent(m[1]);
    return p.includes('ui/icon/');
  } catch {
    return false;
  }
}

async function loadAbilityMap(abilityIds) {
  const table = process.env.ABILITY_MASTER_TABLE;
  const out = new Map();
  if (!table || abilityIds.length === 0) return out;
  const keys = [...new Set(abilityIds)].map((abilityId) => ({ abilityId }));
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const res = await ddb.send(
      new BatchGetCommand({
        RequestItems: {
          [table]: {
            Keys: chunk
          }
        }
      })
    );
    const rows = res.Responses?.[table] ?? [];
    for (const row of rows) {
      const id = Number(row.abilityId);
      const name = normalizeAbilityName(row.nameJa) ?? normalizeAbilityName(row.nameEn);
      if (Number.isFinite(id) && name) {
        out.set(id, name);
      }
    }
  }
  return out;
}

function collectAbilityIds(events) {
  const ids = [];
  for (const e of events) {
    const id = e.abilityGameID ?? e.ability?.gameID ?? e.ability?.guid;
    if (typeof id === 'number' && Number.isFinite(id) && id > 0) {
      ids.push(id);
    }
  }
  return [...new Set(ids)];
}

async function saveAnalysisCache(payload, unresolvedAbilityIds) {
  const table = process.env.ANALYSIS_CACHE_TABLE;
  if (!table) return;
  const now = Date.now();
  const ttl = Math.floor((now + 1000 * 60 * 60 * 24 * 3) / 1000);
  const hash = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: {
        cacheKey: `analyze#${hash}`,
        createdAt: now,
        ttl,
        unresolvedAbilityIds
      }
    })
  );
}

async function maybeLoadCached(payload) {
  const table = process.env.ANALYSIS_CACHE_TABLE;
  if (!table) return null;
  const hash = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
  const res = await ddb.send(
    new GetCommand({
      TableName: table,
      Key: { cacheKey: `result#${hash}` }
    })
  );
  return res.Item?.result ?? null;
}

async function saveCachedResult(payload, result) {
  const table = process.env.ANALYSIS_CACHE_TABLE;
  if (!table) return;
  const now = Date.now();
  const ttl = Math.floor((now + 1000 * 60 * 30) / 1000);
  const hash = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: {
        cacheKey: `result#${hash}`,
        createdAt: now,
        ttl,
        result
      }
    })
  );
}

async function handleReportFights(query) {
  const reportCode = (query.reportCode ?? '').trim();
  const translate = toBool(query.translate, true);
  const locale = query.locale ?? 'ja';
  if (!reportCode) {
    return err(400, 'reportCode is required');
  }
  const client = makeClient(locale);
  const report = await getReportFights(client, reportCode, { translate });
  return ok({ fights: report.fights });
}

async function handleRankings(query) {
  const startedAt = Date.now();
  const softLimitMs = 22000;
  const encounterId = Number(query.encounterId);
  const metric = (query.metric ?? 'dps').trim();
  const difficultyRaw = Number(query.difficulty);
  const difficulty = Number.isFinite(difficultyRaw) ? difficultyRaw : undefined;
  const pageSizeRaw = Number(query.pageSize ?? '10');
  const pageSize = Number.isFinite(pageSizeRaw) ? Math.max(1, Math.min(100, pageSizeRaw)) : 10;
  const rankIndex = Number(query.rankIndex ?? '0');
  const job = String(query.job ?? '').trim();
  if (!Number.isFinite(encounterId) || !metric) {
    return err(400, 'encounterId and metric are required');
  }
  logInfo('rankings.start', {
    encounterId,
    metric,
    difficulty: difficulty ?? null,
    pageSize,
    rankIndex,
    job: job || null
  });
  const client = makeClient('ja');
  const mapped = difficulty === 101 ? 5 : difficulty === 100 ? 4 : difficulty === 102 ? 6 : difficulty;
  const partitionRaw = Number(query.partition);
  const partition = Number.isFinite(partitionRaw) ? partitionRaw : undefined;
  const tries = [
    { difficulty, partition, pageSize },
    { difficulty: mapped, partition, pageSize },
    { difficulty: mapped, partition: undefined, pageSize },
    { difficulty: undefined, partition: undefined, pageSize },
    { difficulty: mapped, partition: 1, pageSize: Math.max(10, pageSize) },
    { difficulty: undefined, partition: 1, pageSize: Math.max(10, pageSize) }
  ].filter(
    (v, i, arr) =>
      (v.difficulty === undefined || Number.isFinite(v.difficulty)) &&
      (v.partition === undefined || Number.isFinite(v.partition)) &&
      arr.findIndex(
        (x) => x.difficulty === v.difficulty && x.partition === v.partition && x.pageSize === v.pageSize
      ) === i
  );
  const attempted = [];
  let last;
  for (const t of tries) {
    if (Date.now() - startedAt > softLimitMs) {
      const timeoutError = new Error(`rankings search exceeded soft limit ${softLimitMs}ms`);
      logError(
        'rankings.soft_timeout',
        {
          encounterId,
          metric,
          difficulty: difficulty ?? null,
          pageSize,
          rankIndex,
          attemptedCount: attempted.length
        },
        timeoutError
      );
      throw new Error(`Rankings fetch timed out. attempted=[${attempted.join(' | ')}]`);
    }
    try {
      attempted.push(
        `difficulty=${t.difficulty == null ? 'undefined' : t.difficulty},size=${t.pageSize},partition=${
          t.partition == null ? 'undefined' : t.partition
        }`
      );
      const r = await getRankings(client, {
        encounterID: encounterId,
        metric,
        difficulty: t.difficulty,
        pageSize: t.pageSize,
        rankIndex,
        className: job || undefined,
        partition: t.partition
      });
      return ok({
        rankings: r.rankings,
        resolvedEncounterId: encounterId,
        resolvedMetric: metric,
        resolvedDifficulty: t.difficulty ?? null,
        resolvedPartition: t.partition ?? null,
        resolvedPageSize: t.pageSize,
        resolvedJob: job || undefined,
        fallbackApplied:
          t.difficulty !== difficulty || t.pageSize !== pageSize || t.partition !== partition,
        attempted
      });
    } catch (e) {
      last = e;
    }
  }
  logError(
    'rankings.failed',
    {
      encounterId,
      metric,
      difficulty: difficulty ?? null,
      pageSize,
      rankIndex,
      attemptedCount: attempted.length
    },
    last
  );
  const detail = last instanceof Error ? last.message : String(last ?? 'Rankings not found');
  throw new Error(`${detail} attempted=[${attempted.join(' | ')}]`);
}

async function handleEncounterSearch(query) {
  const q = (query.q ?? '').trim();
  const max = Number(query.max ?? '30');
  const client = makeClient('ja');
  if (!q) {
    return ok({ encounters: [] });
  }
  const encounters = await searchEncounters(client, q, Number.isFinite(max) ? Math.max(1, Math.min(100, max)) : 30);
  return ok({ encounters });
}

async function handleEncounterGroups() {
  const client = makeClient('ja');
  const groups = await getEncounterGroups(client);
  return ok({ groups });
}

async function handleCharacterContents(query) {
  const name = String(query.name ?? '').trim();
  const serverSlug = normalizeServerSlug(query.server ?? query.serverSlug);
  const serverRegion = normalizeRegion(query.region ?? query.serverRegion);
  if (!name || !serverSlug || !serverRegion) {
    return err(400, 'name, server, region are required');
  }

  const client = makeClient('ja');
  let data;
  try {
    data = await client.request(buildCharacterContentsQueryString(true), {
      name,
      serverSlug,
      serverRegion
    });
  } catch {
    try {
      data = await client.request(buildCharacterContentsQueryEnum(serverRegion, true), { name, serverSlug });
    } catch {
      data = await client.request(buildCharacterContentsQueryString(false), {
        name,
        serverSlug,
        serverRegion
      });
    }
  }

  const character = data?.characterData?.character;
  if (!character) {
    return ok({ character: null, contents: [], reports: [] });
  }

  const contents = extractCharacterContents(character.zoneRankings);
  const reports = Array.isArray(character.recentReports?.data)
    ? character.recentReports.data
        .map((x) => ({
          code: x?.code,
          title: x?.title,
          startTime: x?.startTime
        }))
        .filter((x) => typeof x.code === 'string' && x.code.trim())
    : [];

  return ok({
    character: {
      name: character.name ?? name,
      serverSlug,
      serverRegion
    },
    contents,
    reports
  });
}

async function handleCharacterSearch(query) {
  const name = String(query.name ?? '').trim();
  const serverRegion = normalizeRegion(query.region ?? query.serverRegion);
  const serverSlugFilter = normalizeServerSlug(query.server ?? query.serverSlug);
  const limit = Math.max(1, Math.min(50, Number(query.limit ?? '20')));
  if (!name || !serverRegion) {
    return err(400, 'name and region are required');
  }

  const rows = await searchCharactersViaXivApi(name, serverSlugFilter, limit * 3);
  const fallbackRows =
    rows.length === 0 && serverSlugFilter
      ? await searchCharacterViaFFLogsExact(makeClient('ja'), name, serverSlugFilter, serverRegion)
      : [];
  const keyword = name.toLowerCase();
  const characters = rows
    .concat(fallbackRows)
    .map((x) => ({
      name: x.name,
      serverName: x.serverName || serverSlugToName(x.serverSlug),
      serverSlug: x.serverSlug,
      region: serverRegion
    }))
    .filter((x) => x.name.toLowerCase().includes(keyword))
    .filter((x) => !serverSlugFilter || x.serverSlug === serverSlugFilter)
    .slice(0, limit);

  return ok({ characters });
}

async function fetchXivApiAction(id, lang) {
  const baseUrl = (process.env.XIVAPI_BASE_URL ?? 'https://v2.xivapi.com').replace(/\/+$/, '');
  const candidates = [baseUrl];
  if (baseUrl.includes('xivapi.com') && !baseUrl.includes('v2.xivapi.com')) {
    candidates.unshift('https://v2.xivapi.com');
  }

  for (const b of candidates) {
    const urls = [
      `${b}/api/sheet/Action/${id}?fields=Name,Icon&language=${encodeURIComponent(lang)}`,
      `${b}/Action/${id}?language=${encodeURIComponent(lang)}`
    ];
    for (const url of urls) {
      const res = await fetch(url);
      if (!res.ok) {
        continue;
      }
      const data = await res.json();
      const fields = data?.fields ?? data;
      const icon = extractIconPath(fields?.Icon);
      const name = typeof fields?.Name === 'string' && fields.Name.trim() ? fields.Name.trim() : undefined;
      return {
        name,
        iconUrl: toAbsoluteIconUrl(b, icon)
      };
    }
  }
  return {};
}

async function handleAbilityIcons(query) {
  const rawIds = String(query.ids ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((v, i, arr) => Number.isFinite(v) && v > 0 && arr.indexOf(v) === i);
  const lang = (query.lang ?? process.env.XIVAPI_LANG ?? 'ja').toString();
  if (rawIds.length === 0) {
    return ok({ icons: {} });
  }

  const table = process.env.ABILITY_MASTER_TABLE;
  const icons = {};
  const missing = [];

  if (table) {
    const keys = rawIds.map((abilityId) => ({ abilityId }));
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const res = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [table]: { Keys: chunk }
          }
        })
      );
      const rows = res.Responses?.[table] ?? [];
      const hit = new Set();
      for (const row of rows) {
        const id = Number(row.abilityId);
        if (!Number.isFinite(id)) continue;
        hit.add(id);
        if (isValidIconUrl(row.iconUrl)) {
          icons[String(id)] = row.iconUrl;
        } else {
          missing.push(id);
        }
      }
      for (const k of chunk) {
        if (!hit.has(k.abilityId)) {
          missing.push(k.abilityId);
        }
      }
    }
  } else {
    missing.push(...rawIds);
  }

  for (const id of missing.slice(0, 200)) {
    const action = await fetchXivApiAction(id, lang);
    if (action.iconUrl) {
      icons[String(id)] = action.iconUrl;
    }
    if (table && (action.name || action.iconUrl)) {
      await ddb.send(
        new PutCommand({
          TableName: table,
          Item: {
            abilityId: id,
            nameJa: lang === 'ja' ? action.name : undefined,
            nameEn: lang === 'en' ? action.name : undefined,
            iconUrl: action.iconUrl,
            updatedAt: Date.now()
          }
        })
      );
    }
  }

  return ok({ icons });
}

async function handleAnalyze(input, fromQuery = false) {
  const body = fromQuery ? input ?? {} : typeof input === 'string' && input ? JSON.parse(input) : {};
  const reportCode = String(body.reportCode ?? '').trim();
  if (!reportCode) {
    return err(400, 'reportCode is required');
  }

  const payload = {
    reportCode,
    strategy: body.strategy ?? 'best',
    onlyKill: fromQuery ? toBool(body.onlyKill, true) : body.onlyKill !== false,
    difficulty: toOptionalNumber(body.difficulty),
    fightId: toOptionalNumber(body.fightId),
    locale: body.locale ?? 'ja',
    translate: fromQuery ? toBool(body.translate, true) : body.translate !== false
  };

  const cached = await maybeLoadCached(payload);
  if (cached) {
    return ok(cached);
  }

  const client = makeClient(payload.locale);
  const report = await getReportFights(client, reportCode, { translate: payload.translate });
  const selectedFight = pickFight(report.fights, {
    strategy: payload.strategy,
    onlyKill: payload.onlyKill,
    difficulty: payload.difficulty,
    reportCode: reportCode,
    debugFightID: payload.fightId
  });
  const actorMap = await getReportActorMap(client, reportCode, { translate: payload.translate });
  const castEvents = await getAllCastEvents(client, {
    reportCode,
    fightID: selectedFight.fightID,
    startTime: selectedFight.startTime,
    endTime: selectedFight.endTime,
    translate: payload.translate
  });
  let bossEvents = castEvents;
  let bossTimeline = buildBossTimeline(bossEvents, actorMap, selectedFight.startTime);
  if (bossTimeline.length === 0) {
    bossEvents = await getAllEvents(client, {
      reportCode,
      fightID: selectedFight.fightID,
      startTime: selectedFight.startTime,
      endTime: selectedFight.endTime,
      dataType: 'All',
      translate: payload.translate
    });
    bossTimeline = buildBossTimeline(bossEvents, actorMap, selectedFight.startTime);
  }

  const abilityIds = collectAbilityIds([...castEvents, ...bossEvents]);
  const abilityMap = await loadAbilityMap(abilityIds);
  const missingAbilityIds = abilityIds.filter((id) => !abilityMap.has(id));
  if (missingAbilityIds.length > 0) {
    const table = process.env.ABILITY_MASTER_TABLE;
    const lang = (body.xivapiLang ?? process.env.XIVAPI_LANG ?? 'ja').toString();
    const maxResolve = 80;
    const concurrency = 8;
    const targets = missingAbilityIds.slice(0, maxResolve);
    for (let i = 0; i < targets.length; i += concurrency) {
      const chunk = targets.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        chunk.map(async (id) => {
          const action = await fetchXivApiAction(id, lang);
          if (action.name) {
            abilityMap.set(id, action.name);
          }
          if (table && (action.name || action.iconUrl)) {
            await ddb.send(
              new PutCommand({
                TableName: table,
                Item: {
                  abilityId: id,
                  nameJa: lang === 'ja' ? action.name : undefined,
                  nameEn: lang === 'en' ? action.name : undefined,
                  iconUrl: action.iconUrl,
                  updatedAt: Date.now()
                }
              })
            );
          }
        })
      );
      void results;
    }
  }
  if (abilityMap.size > 0) {
    bossTimeline = buildBossTimeline(bossEvents, actorMap, selectedFight.startTime, abilityMap);
  }
  const playersCasts = buildPlayerCasts(castEvents, actorMap, selectedFight.startTime, abilityMap.size > 0 ? abilityMap : undefined);
  const playersSummary = buildPlayerSummary(playersCasts, selectedFight.durationMs);

  const unresolvedAbilityIds = abilityIds.filter((id) => !abilityMap.has(id));
  const result = {
    fights: report.fights,
    selectedFight,
    bossTimeline,
    playersCasts,
    playersSummary,
    unresolvedAbilityCounts: unresolvedAbilityIds.reduce((acc, id) => {
      acc[id] = (acc[id] ?? 0) + 1;
      return acc;
    }, {})
  };

  await saveAnalysisCache(payload, unresolvedAbilityIds);
  await saveCachedResult(payload, result);
  return ok(result);
}

exports.handler = async (event) => {
  const startedAt = Date.now();
  const method = event?.requestContext?.http?.method ?? 'GET';
  const stage = event?.requestContext?.stage ?? process.env.STAGE_NAME;
  const path = normalizePath(event?.rawPath ?? '/', stage);
  const requestId =
    event?.requestContext?.requestId ??
    event?.headers?.['x-amzn-trace-id'] ??
    `local-${Date.now()}`;
  const queryKeys = Object.keys(event?.queryStringParameters ?? {});
  logInfo('request.start', { requestId, method, path, stage, queryKeys });

  try {
    let response;
    if (method === 'GET' && path === '/health') {
      response = ok({ ok: true, ts: Date.now() });
      logInfo('request.done', { requestId, method, path, statusCode: response.statusCode, durationMs: Date.now() - startedAt });
      return response;
    }
    if (method === 'GET' && path === '/report/fights') {
      response = await handleReportFights(event.queryStringParameters ?? {});
      logInfo('request.done', { requestId, method, path, statusCode: response.statusCode, durationMs: Date.now() - startedAt });
      return response;
    }
    if (method === 'GET' && path === '/rankings/search') {
      response = await handleRankings(event.queryStringParameters ?? {});
      logInfo('request.done', { requestId, method, path, statusCode: response.statusCode, durationMs: Date.now() - startedAt });
      return response;
    }
    if (method === 'GET' && path === '/encounters/search') {
      response = await handleEncounterSearch(event.queryStringParameters ?? {});
      logInfo('request.done', { requestId, method, path, statusCode: response.statusCode, durationMs: Date.now() - startedAt });
      return response;
    }
    if (method === 'GET' && path === '/encounters/groups') {
      response = await handleEncounterGroups();
      logInfo('request.done', { requestId, method, path, statusCode: response.statusCode, durationMs: Date.now() - startedAt });
      return response;
    }
    if (method === 'GET' && path === '/character/contents') {
      response = await handleCharacterContents(event.queryStringParameters ?? {});
      logInfo('request.done', { requestId, method, path, statusCode: response.statusCode, durationMs: Date.now() - startedAt });
      return response;
    }
    if (method === 'GET' && path === '/character/search') {
      response = await handleCharacterSearch(event.queryStringParameters ?? {});
      logInfo('request.done', { requestId, method, path, statusCode: response.statusCode, durationMs: Date.now() - startedAt });
      return response;
    }
    if (method === 'GET' && path === '/ability-icons') {
      response = await handleAbilityIcons(event.queryStringParameters ?? {});
      logInfo('request.done', { requestId, method, path, statusCode: response.statusCode, durationMs: Date.now() - startedAt });
      return response;
    }
    if (method === 'GET' && path === '/report/analyze') {
      response = await handleAnalyze(event.queryStringParameters ?? {}, true);
      logInfo('request.done', { requestId, method, path, statusCode: response.statusCode, durationMs: Date.now() - startedAt });
      return response;
    }
    if (method === 'POST' && path === '/report/analyze') {
      response = await handleAnalyze(event.body, false);
      logInfo('request.done', { requestId, method, path, statusCode: response.statusCode, durationMs: Date.now() - startedAt });
      return response;
    }
    response = err(404, `Not found: ${method} ${path}`);
    logInfo('request.done', { requestId, method, path, statusCode: response.statusCode, durationMs: Date.now() - startedAt });
    return response;
  } catch (e) {
    logError('request.error', { requestId, method, path, durationMs: Date.now() - startedAt }, e);
    return err(500, e instanceof Error ? e.message : String(e));
  }
};
