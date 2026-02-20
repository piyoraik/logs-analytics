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
  const encounterId = Number(query.encounterId);
  const metric = (query.metric ?? 'dps').trim();
  const difficulty = Number(query.difficulty);
  const pageSize = Number(query.pageSize ?? '10');
  const rankIndex = Number(query.rankIndex ?? '0');
  if (!Number.isFinite(encounterId) || !metric || !Number.isFinite(difficulty)) {
    return err(400, 'encounterId, metric, difficulty are required');
  }
  const client = makeClient('ja');
  const candidates = [difficulty, difficulty === 101 ? 5 : difficulty].filter(
    (v, i, arr) => Number.isFinite(v) && arr.indexOf(v) === i
  );
  let last;
  for (const d of candidates) {
    try {
      const r = await getRankings(client, {
        encounterID: encounterId,
        metric,
        difficulty: d,
        pageSize,
        rankIndex
      });
      return ok({
        rankings: r.rankings,
        resolvedEncounterId: encounterId,
        resolvedMetric: metric,
        resolvedDifficulty: d,
        fallbackApplied: d !== difficulty
      });
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error('Rankings not found');
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
  try {
    const method = event?.requestContext?.http?.method ?? 'GET';
    const stage = event?.requestContext?.stage ?? process.env.STAGE_NAME;
    const path = normalizePath(event?.rawPath ?? '/', stage);
    if (method === 'GET' && path === '/health') {
      return ok({ ok: true, ts: Date.now() });
    }
    if (method === 'GET' && path === '/report/fights') {
      return await handleReportFights(event.queryStringParameters ?? {});
    }
    if (method === 'GET' && path === '/rankings/search') {
      return await handleRankings(event.queryStringParameters ?? {});
    }
    if (method === 'GET' && path === '/encounters/search') {
      return await handleEncounterSearch(event.queryStringParameters ?? {});
    }
    if (method === 'GET' && path === '/encounters/groups') {
      return await handleEncounterGroups();
    }
    if (method === 'GET' && path === '/ability-icons') {
      return await handleAbilityIcons(event.queryStringParameters ?? {});
    }
    if (method === 'GET' && path === '/report/analyze') {
      return await handleAnalyze(event.queryStringParameters ?? {}, true);
    }
    if (method === 'POST' && path === '/report/analyze') {
      return await handleAnalyze(event.body, false);
    }
    return err(404, `Not found: ${method} ${path}`);
  } catch (e) {
    return err(500, e instanceof Error ? e.message : String(e));
  }
};
