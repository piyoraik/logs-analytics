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

  return {
    rank: Number(raw.rank ?? 0),
    amount: Number(raw.amount ?? 0),
    reportCode,
    fightID,
    characterName: raw.character?.name ?? raw.name,
    serverName: raw.character?.server?.name ?? raw.server,
    region: raw.character?.server?.region?.slug,
    className: raw.character?.classID ? String(raw.character.classID) : raw.class ? String(raw.class) : undefined,
    specName: raw.character?.spec ? String(raw.character.spec) : raw.spec ? String(raw.spec) : undefined
  };
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
    if (typeof v.partition === 'number') {
      variables.partition = v.partition;
    }
    return client.request<RankingsQueryData>(CHARACTER_RANKINGS_QUERY, variables);
  };

  const resolveRankingRows = async (rows: any[]): Promise<RankingEntry[]> => {
    const desiredCount = Math.max(params.rankIndex + 1, Math.min(Math.max(params.pageSize ?? 10, 1), 10));
    const entries: RankingEntry[] = [];
    const unresolved: Array<{
      row: any;
      reportCode: string;
    }> = [];

    for (const row of rows) {
      const normalized = normalizeRanking(row);
      if (normalized) {
        entries.push(normalized);
        if (entries.length >= desiredCount) {
          return entries;
        }
        continue;
      }
      const reportCode = parseReportCode(row);
      if (!reportCode) {
        continue;
      }
      unresolved.push({ row, reportCode });
      if (unresolved.length >= 20) {
        break;
      }
    }

    if (entries.length >= desiredCount || unresolved.length === 0) {
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
      if (entries.length >= desiredCount) {
        break;
      }
    }

    return entries;
  };

  let data: RankingsQueryData;
  try {
    data = await requestRankings({
      encounterID: params.encounterID,
      metric: params.metric,
      difficulty: params.difficulty,
      size: params.pageSize,
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
          size: params.pageSize
        });
      } catch {
        data = await client.request<RankingsQueryData>(CHARACTER_RANKINGS_QUERY_METRIC_ONLY, {
          encounterID: params.encounterID,
          metric: params.metric
        });
      }
    } else {
      data = await client.request<RankingsQueryData>(CHARACTER_RANKINGS_QUERY_METRIC_ONLY, {
        encounterID: params.encounterID,
        metric: params.metric
      });
    }
  }

  const rankingsRaw = extractRankingsRows(data.worldData.encounter?.characterRankings);
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
            size: params.pageSize
          });
          relaxedRows = extractRankingsRows(mapped.worldData.encounter?.characterRankings);
        } catch {
          // noop
        }
      }
      if (relaxedRows.length === 0) {
        const relaxed = await client.request<RankingsQueryData>(CHARACTER_RANKINGS_QUERY_METRIC_ONLY, {
          encounterID: params.encounterID,
          metric: params.metric
        });
        relaxedRows = extractRankingsRows(relaxed.worldData.encounter?.characterRankings);
      }
      if (relaxedRows.length > 0) {
        const relaxedRankings = await resolveRankingRows(relaxedRows);
        if (relaxedRankings.length > 0) {
          if (params.rankIndex < 0 || params.rankIndex >= relaxedRankings.length) {
            throw new Error(
              `rank-index out of range. index=${params.rankIndex}, available=0..${relaxedRankings.length - 1}`
            );
          }
          return {
            encounterID: params.encounterID,
            metric: params.metric,
            difficulty: params.difficulty,
            pageSize: params.pageSize,
            rankIndex: params.rankIndex,
            filters: {
              region: params.region,
              server: params.server,
              className: params.className,
              specName: params.specName,
              partition: params.partition
            },
            rankings: relaxedRankings
          };
        }
      }
    }
    throw new Error(
      `Rankings not found for given criteria. Check encounter/metric/difficulty/visibility.${reason} payloadKeys=[${shape}]`
    );
  }

  const rankings = await resolveRankingRows(rankingsRaw);

  if (rankings.length === 0) {
    const sample = rankingsRaw[0] && typeof rankingsRaw[0] === 'object' ? Object.keys(rankingsRaw[0]).slice(0, 20) : [];
    throw new Error(
      `No usable ranking entries returned (missing reportCode/fightID). sampleKeys=[${sample.join(',')}]`
    );
  }

  if (params.rankIndex < 0 || params.rankIndex >= rankings.length) {
    throw new Error(`rank-index out of range. index=${params.rankIndex}, available=0..${rankings.length - 1}`);
  }

  return {
    encounterID: params.encounterID,
    metric: params.metric,
    difficulty: params.difficulty,
    pageSize: params.pageSize,
    rankIndex: params.rankIndex,
    filters: {
      region: params.region,
      server: params.server,
      className: params.className,
      specName: params.specName,
      partition: params.partition
    },
    rankings
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
