import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { FFLogsGraphQLClient } from './fflogs/client';
import { getAllCastEvents, getAllEvents, getReportActorMap, getReportFights } from './fflogs/report';
import { getRankings } from './fflogs/rankings';
import { CastEvent, RankingsResult, SelectedFightMeta } from './fflogs/types';
import { buildPlayerCasts } from './players/playerCasts';
import { buildPlayerSummary } from './players/summary';
import { pickFight } from './select/pickFight';
import { buildBossTimeline } from './timeline/bossTimeline';
import { XivApiAbilityResolver } from './abilities/xivapi';
import { loadAbilityOverrides } from './abilities/overrides';

interface CliArgs {
  report?: string;
  rankings: boolean;
  translate: boolean;
  locale?: string;
  xivapiFallback: boolean;
  xivapiLang: string;
  xivapiBaseUrl: string;
  xivapiCachePath: string;
  abilityOverridesPath: string;
  pick: string;
  onlyKill: boolean;
  difficulty?: number;
  fightId?: number;
  encounterId?: number;
  metric?: string;
  pageSize: number;
  rankIndex: number;
  region?: string;
  server?: string;
  job?: string;
  partition?: number;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) {
    return defaultValue;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}. Use true/false.`);
}

function parseNumber(name: string, value: string | undefined): number {
  if (!value) {
    throw new Error(`Missing required option: --${name}`);
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid number for --${name}: ${value}`);
  }
  return num;
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      map.set(key, 'true');
      continue;
    }
    map.set(key, next);
    i += 1;
  }

  return {
    report: map.get('report'),
    rankings: parseBoolean(map.get('rankings'), false),
    translate: parseBoolean(map.get('translate'), true),
    locale: map.get('locale') ?? process.env.FFLOGS_LOCALE ?? 'ja',
    xivapiFallback: parseBoolean(map.get('xivapi-fallback'), true),
    xivapiLang: map.get('xivapi-lang') ?? process.env.XIVAPI_LANG ?? 'ja',
    xivapiBaseUrl: map.get('xivapi-base-url') ?? process.env.XIVAPI_BASE_URL ?? 'https://xivapi.com',
    xivapiCachePath:
      map.get('xivapi-cache-path') ??
      process.env.XIVAPI_CACHE_PATH ??
      path.resolve(process.cwd(), 'out', 'xivapi_ability_cache.json'),
    abilityOverridesPath:
      map.get('ability-overrides-path') ??
      process.env.ABILITY_OVERRIDES_PATH ??
      path.resolve(process.cwd(), 'out', 'ability_overrides.json'),
    pick: map.get('pick') ?? 'best',
    onlyKill: parseBoolean(map.get('only-kill'), true),
    difficulty: map.has('difficulty') ? parseNumber('difficulty', map.get('difficulty')) : undefined,
    fightId: map.has('fight-id') ? parseNumber('fight-id', map.get('fight-id')) : undefined,
    encounterId: map.has('encounter-id') ? parseNumber('encounter-id', map.get('encounter-id')) : undefined,
    metric: map.get('metric'),
    pageSize: map.has('page-size') ? parseNumber('page-size', map.get('page-size')) : 10,
    rankIndex: map.has('rank-index') ? parseNumber('rank-index', map.get('rank-index')) : 0,
    region: map.get('region'),
    server: map.get('server'),
    job: map.get('job'),
    partition: map.has('partition') ? parseNumber('partition', map.get('partition')) : undefined
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

async function writeJsonFile<T>(outDir: string, fileName: string, payload: T): Promise<void> {
  const fullPath = path.join(outDir, fileName);
  await writeFile(fullPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function printSelectedFight(selected: SelectedFightMeta): void {
  const durationSec = (selected.durationMs / 1000).toFixed(1);
  console.log('Selected Fight');
  console.log('-------------');
  console.log(`reportCode : ${selected.reportCode}`);
  console.log(`fightID    : ${selected.fightID}`);
  console.log(`encounter  : ${selected.encounterID} (${selected.name})`);
  console.log(`kill       : ${selected.kill}`);
  console.log(`difficulty : ${selected.difficulty ?? 'n/a'}`);
  console.log(`duration   : ${durationSec}s`);
  console.log(`reason     : ${selected.reason}`);
  console.log('');
}

function printTopPlayers(summary: ReturnType<typeof buildPlayerSummary>): void {
  console.log('Top Players By Cast Count');
  console.log('-------------------------');
  const rows = summary.slice(0, 10);
  const header = ['Player', 'TotalCasts', 'TopAbility(count)'];
  console.log(`${header[0].padEnd(24)} ${header[1].padStart(10)} ${header[2]}`);
  for (const row of rows) {
    const top = row.abilities[0];
    const topText = top ? `${top.ability} (${top.count})` : '-';
    console.log(`${row.player.padEnd(24)} ${String(row.totalCasts).padStart(10)} ${topText}`);
  }
}

interface AnalysisSeed {
  reportCode: string;
  selectedFight: SelectedFightMeta;
  rankingsDump?: RankingsResult;
  fightsDump?: unknown;
}

async function resolveSeed(client: FFLogsGraphQLClient, args: CliArgs): Promise<AnalysisSeed> {
  if (args.rankings) {
    if (args.encounterId == null || !args.metric || args.difficulty == null) {
      throw new Error(
        'rankings mode requires --encounter-id, --metric, --difficulty (plus optional --page-size/--rank-index).'
      );
    }

    const rankings = await getRankings(client, {
      encounterID: args.encounterId,
      metric: args.metric,
      difficulty: args.difficulty,
      pageSize: args.pageSize,
      rankIndex: args.rankIndex,
      region: args.region,
      server: args.server,
      className: args.job,
      partition: args.partition
    });

    const selectedRanking = rankings.rankings[rankings.rankIndex];
    const fightsResult = await getReportFights(client, selectedRanking.reportCode, {
      translate: args.translate
    });

    const picked = pickFight(fightsResult.fights, {
      strategy: 'best',
      onlyKill: args.onlyKill,
      difficulty: args.difficulty,
      reportCode: selectedRanking.reportCode,
      debugFightID: args.fightId ?? selectedRanking.fightID
    });

    return {
      reportCode: selectedRanking.reportCode,
      selectedFight: { ...picked, reason: `rankings[index=${args.rankIndex}]` },
      rankingsDump: rankings
    };
  }

  if (!args.report) {
    throw new Error('report mode requires --report <reportCode> (or use --rankings true).');
  }

  const fightsResult = await getReportFights(client, args.report, {
    translate: args.translate
  });
  const selectedFight = pickFight(fightsResult.fights, {
    strategy: args.pick,
    onlyKill: args.onlyKill,
    difficulty: args.difficulty,
    reportCode: fightsResult.reportCode,
    debugFightID: args.fightId
  });

  return {
    reportCode: fightsResult.reportCode,
    selectedFight,
    fightsDump: {
      reportCode: fightsResult.reportCode,
      options: {
        strategy: args.pick,
        onlyKill: args.onlyKill,
        translate: args.translate,
        locale: args.locale,
        xivapiFallback: args.xivapiFallback,
        xivapiLang: args.xivapiLang,
        xivapiBaseUrl: args.xivapiBaseUrl,
        xivapiCachePath: args.xivapiCachePath,
        abilityOverridesPath: args.abilityOverridesPath,
        difficulty: args.difficulty,
        debugFightID: args.fightId
      },
      selected: selectedFight,
      fights: fightsResult.fights
    }
  };
}

async function runPipeline(
  client: FFLogsGraphQLClient,
  reportCode: string,
  selectedFight: SelectedFightMeta,
  args: CliArgs
): Promise<{
  events: CastEvent[];
  bossTimeline: ReturnType<typeof buildBossTimeline>;
  castsByPlayer: ReturnType<typeof buildPlayerCasts>;
  playersSummary: ReturnType<typeof buildPlayerSummary>;
  xivApiStats?: unknown;
  unresolvedAbilityCounts?: Record<string, number>;
}> {
  const actorMap = await getReportActorMap(client, reportCode, { translate: args.translate });
  const castEvents = await getAllCastEvents(client, {
    reportCode,
    fightID: selectedFight.fightID,
    startTime: selectedFight.startTime,
    endTime: selectedFight.endTime,
    translate: args.translate
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
      translate: args.translate
    });
    bossTimeline = buildBossTimeline(bossEvents, actorMap, selectedFight.startTime);
  }

  let xivApiResolved = new Map<number, string>();
  let xivApiStats: unknown = undefined;
  if (args.xivapiFallback) {
    console.log('Resolving ability names via XIVAPI...');
    const resolver = new XivApiAbilityResolver({
      enabled: true,
      baseUrl: args.xivapiBaseUrl,
      language: args.xivapiLang,
      cachePath: args.xivapiCachePath
    });
    const mergedEvents = [...castEvents, ...bossEvents];
    const resolvedResult = await resolver.resolveMissing(mergedEvents, actorMap.abilityByGameId, {
      includeKnown: true
    });
    xivApiResolved = resolvedResult.resolved;
    xivApiStats = {
      ...resolvedResult.stats,
      force: true,
      cachePath: args.xivapiCachePath,
      baseUrl: args.xivapiBaseUrl,
      language: args.xivapiLang
    };
    const summary = resolvedResult.stats;
    console.log(
      `XIVAPI resolve done: fetched=${summary.fetched}, resolved=${summary.resolved}, notResolved=${summary.notResolved}, cacheHit=${summary.cacheHit}`
    );
  }

  const overrides = await loadAbilityOverrides(args.abilityOverridesPath);
  const finalAbilityById = new Map<number, string>(xivApiResolved);
  for (const [id, name] of overrides.entries()) {
    finalAbilityById.set(id, name);
  }

  const unresolvedMap = new Map<number, number>();
  const mergedEvents = [...castEvents, ...bossEvents];
  for (const event of mergedEvents) {
    const abilityId = event.abilityGameID ?? event.ability?.gameID ?? event.ability?.guid;
    if (typeof abilityId !== 'number' || !Number.isFinite(abilityId)) {
      continue;
    }
    if (!finalAbilityById.has(abilityId)) {
      unresolvedMap.set(abilityId, (unresolvedMap.get(abilityId) ?? 0) + 1);
    }
  }
  const unresolvedAbilityCounts: Record<string, number> = {};
  for (const [id, count] of [...unresolvedMap.entries()].sort((a, b) => b[1] - a[1])) {
    unresolvedAbilityCounts[String(id)] = count;
  }

  bossTimeline = buildBossTimeline(bossEvents, actorMap, selectedFight.startTime, finalAbilityById);
  const castsByPlayer = buildPlayerCasts(castEvents, actorMap, selectedFight.startTime, finalAbilityById);
  const playersSummary = buildPlayerSummary(castsByPlayer, selectedFight.durationMs);

  return {
    events: castEvents,
    bossTimeline,
    castsByPlayer,
    playersSummary,
    xivApiStats,
    unresolvedAbilityCounts
  };
}

function printUsage(): void {
  console.log('Usage examples:');
  console.log(
    '  report mode  : npm run dev -- --report <code> --pick best --translate true --locale ja --xivapi-fallback true'
  );
  console.log(
    '  rankings mode: npm run dev -- --rankings true --encounter-id 123 --metric dps --difficulty 101 --page-size 10 --rank-index 0'
  );
}

export async function runCli(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  if (process.argv.includes('--help')) {
    printUsage();
    return;
  }

  const client = new FFLogsGraphQLClient({
    clientId: requireEnv('FFLOGS_CLIENT_ID'),
    clientSecret: requireEnv('FFLOGS_CLIENT_SECRET'),
    tokenUrl: requireEnv('FFLOGS_TOKEN_URL'),
    graphqlUrl: requireEnv('FFLOGS_GRAPHQL_URL'),
    locale: args.locale
  });

  const outDir = path.resolve(process.cwd(), 'out');
  await mkdir(outDir, { recursive: true });

  const seed = await resolveSeed(client, args);

  if (seed.fightsDump) {
    await writeJsonFile(outDir, 'fights.json', seed.fightsDump);
  }
  if (seed.rankingsDump) {
    await writeJsonFile(outDir, 'rankings.json', seed.rankingsDump);
  }

  const { bossTimeline, castsByPlayer, playersSummary, xivApiStats, unresolvedAbilityCounts } =
    await runPipeline(
    client,
    seed.reportCode,
    seed.selectedFight,
    args
    );

  await writeJsonFile(outDir, 'selected_fight.json', seed.selectedFight);
  await writeJsonFile(outDir, 'boss_timeline.json', bossTimeline);
  await writeJsonFile(outDir, 'players_casts.json', castsByPlayer);
  await writeJsonFile(outDir, 'players_summary.json', playersSummary);
  if (unresolvedAbilityCounts) {
    await writeJsonFile(outDir, 'unresolved_abilities.json', unresolvedAbilityCounts);
  }
  if (xivApiStats) {
    await writeJsonFile(outDir, 'xivapi_resolve_report.json', xivApiStats);
  }

  printSelectedFight(seed.selectedFight);
  printTopPlayers(playersSummary);
}
