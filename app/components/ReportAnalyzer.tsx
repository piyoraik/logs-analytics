'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import TimelineGrid from './TimelineGrid';
import { buildViewModel } from '../../lib/transform';
import { Fight, ViewModel } from '../../lib/types';

type PickStrategy = 'best' | 'lastKill' | 'firstKill' | 'longest';
type SourceMode = 'report' | 'rankings' | 'character';
type RankingMetric = 'dps' | 'rdps' | 'hps' | 'bossdps';

interface RankingEntry {
  rank: number;
  amount: number;
  reportCode: string;
  fightID: number;
  bestPercent?: number;
  highestRdps?: number;
  kill?: boolean;
  fastestSec?: number;
  medianRdps?: number;
  characterName?: string;
  serverName?: string;
  region?: string;
  className?: string;
  specName?: string;
}

interface EncounterGroup {
  zoneId: number;
  zoneName: string;
  encounters: Array<{ id: number; name: string }>;
}

interface AnalyzeResponse {
  fights: Fight[];
  selectedFight: any;
  bossTimeline: any[];
  playersCasts: Record<string, any[]>;
  playersSummary: any[];
  unresolvedAbilityCounts?: Record<string, number>;
}

interface RankingsFetchResponse {
  rankings: RankingEntry[];
  resolvedEncounterId?: number;
  resolvedMetric?: string;
  resolvedDifficulty?: number;
  fallbackApplied?: boolean;
  note?: string;
}

interface CharacterContent {
  zoneId: number;
  zoneName: string;
  encounterId: number;
  encounterName: string;
  bestPercent: number;
  totalKills: number;
}

interface CharacterContentsResponse {
  character: { name: string; serverSlug: string; serverRegion: string } | null;
  contents: CharacterContent[];
  reports: Array<{ code: string; title?: string; startTime?: number }>;
}

interface CharacterCandidate {
  name: string;
  serverName: string;
  serverSlug: string;
  region: string;
}

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');
const USE_NEXT_API = process.env.NEXT_PUBLIC_USE_NEXT_API === 'true';

function apiUrl(path: string): string {
  if (USE_NEXT_API) {
    return `/api${path}`;
  }
  if (path.startsWith('/character/') && !API_BASE_URL) {
    return `/api${path}`;
  }
  if (!API_BASE_URL) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL is not set.');
  }
  return `${API_BASE_URL}${path}`;
}

async function fetchFights(reportCode: string): Promise<Fight[]> {
  const res = await fetch(
    apiUrl(`/report/fights?reportCode=${encodeURIComponent(reportCode)}&translate=true&locale=ja`)
  );
  if (!res.ok) {
    throw new Error((await res.json()).error ?? 'Failed to fetch fights');
  }
  const json = (await res.json()) as { fights: Fight[] };
  return json.fights;
}

async function fetchRankings(params: {
  encounterId: number;
  metric: string;
  difficulty: number;
  pageSize: number;
  job?: string;
  timeoutMs?: number;
}): Promise<RankingsFetchResponse> {
  const q = new URLSearchParams({
    encounterId: String(params.encounterId),
    metric: params.metric,
    difficulty: String(params.difficulty),
    pageSize: String(params.pageSize)
  });
  if (params.job?.trim()) {
    q.set('job', params.job.trim());
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 30000);
  let res: Response;
  try {
    res = await fetch(apiUrl(`/rankings/search?${q.toString()}`), { signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      const timeoutSec = Math.floor((params.timeoutMs ?? 45000) / 1000);
      throw new Error(`Fetch Rankings timed out (${timeoutSec}s). 条件を絞るか別Encounterで試してください。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error((await res.json()).error ?? 'Failed to fetch rankings');
  }
  return (await res.json()) as RankingsFetchResponse;
}

async function fetchEncounterGroups(): Promise<EncounterGroup[]> {
  const res = await fetch(apiUrl('/encounters/groups'));
  if (!res.ok) {
    throw new Error((await res.json()).error ?? 'Failed to load encounter groups');
  }
  const json = (await res.json()) as { groups: EncounterGroup[] };
  return json.groups;
}

async function fetchCharacterContents(params: {
  name: string;
  server: string;
  region: string;
}): Promise<CharacterContentsResponse> {
  const q = new URLSearchParams({
    name: params.name,
    server: params.server,
    region: params.region
  });
  const res = await fetch(apiUrl(`/character/contents?${q.toString()}`));
  if (!res.ok) {
    throw new Error((await res.json()).error ?? 'Failed to load character contents');
  }
  return (await res.json()) as CharacterContentsResponse;
}

async function fetchCharacterCandidates(params: {
  name: string;
  region: string;
  server?: string;
  limit?: number;
}): Promise<CharacterCandidate[]> {
  const q = new URLSearchParams({
    name: params.name,
    region: params.region,
    limit: String(params.limit ?? 20)
  });
  if (params.server && params.server.trim()) {
    q.set('server', params.server.trim());
  }
  const res = await fetch(apiUrl(`/character/search?${q.toString()}`));
  if (!res.ok) {
    throw new Error((await res.json()).error ?? 'Failed to search character');
  }
  const json = (await res.json()) as { characters: CharacterCandidate[] };
  return json.characters;
}

const SERVER_OPTIONS: Record<string, string[]> = {
  JP: [
    'aegis', 'alexander', 'anima', 'asura', 'atomos', 'bahamut', 'belias', 'carbuncle', 'chocobo', 'durandal',
    'fenrir', 'garuda', 'gungnir', 'hades', 'ifrit', 'ixion', 'kujata', 'mandragora', 'masamune', 'pandaemonium',
    'ramuh', 'ridill', 'shinryu', 'tiamat', 'titan', 'tonberry', 'typhon', 'ultima', 'unicorn', 'valefor',
    'yojimbo', 'zeromus'
  ],
  US: [
    'adamantoise', 'cactuar', 'faerie', 'gilgamesh', 'jenova', 'midgardsormr', 'sargatanas', 'siren', 'behemoth',
    'excalibur', 'exodus', 'famfrit', 'hyperion', 'lamia', 'leviathan', 'ultros', 'brynhildr', 'coeurl', 'diabolos',
    'goblin', 'malboro', 'mateus', 'zalera'
  ],
  EU: [
    'alpha', 'lich', 'odin', 'phoenix', 'raiden', 'shiva', 'twintania', 'zodiark', 'cerberus', 'louisoix',
    'moogle', 'omega', 'phantom', 'ragnarok', 'sagittarius', 'spriggan'
  ],
  OC: ['bismarck', 'ravana', 'sephirot', 'sophia', 'zurvan'],
  KR: ['moogle', 'chocobo', 'carbuncle', 'cactuar', 'tonberry']
};

const JOB_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All jobs' },
  { value: 'paladin', label: 'PLD (Paladin)' },
  { value: 'warrior', label: 'WAR (Warrior)' },
  { value: 'darkknight', label: 'DRK (Dark Knight)' },
  { value: 'gunbreaker', label: 'GNB (Gunbreaker)' },
  { value: 'whitemage', label: 'WHM (White Mage)' },
  { value: 'scholar', label: 'SCH (Scholar)' },
  { value: 'astrologian', label: 'AST (Astrologian)' },
  { value: 'sage', label: 'SGE (Sage)' },
  { value: 'monk', label: 'MNK (Monk)' },
  { value: 'dragoon', label: 'DRG (Dragoon)' },
  { value: 'ninja', label: 'NIN (Ninja)' },
  { value: 'samurai', label: 'SAM (Samurai)' },
  { value: 'reaper', label: 'RPR (Reaper)' },
  { value: 'viper', label: 'VPR (Viper)' },
  { value: 'bard', label: 'BRD (Bard)' },
  { value: 'machinist', label: 'MCH (Machinist)' },
  { value: 'dancer', label: 'DNC (Dancer)' },
  { value: 'blackmage', label: 'BLM (Black Mage)' },
  { value: 'summoner', label: 'SMN (Summoner)' },
  { value: 'redmage', label: 'RDM (Red Mage)' },
  { value: 'pictomancer', label: 'PCT (Pictomancer)' }
];
const JOB_LABEL_BY_VALUE: Record<string, string> = JOB_OPTIONS.reduce<Record<string, string>>((acc, x) => {
  if (x.value) {
    acc[x.value] = x.label;
  }
  return acc;
}, {});

async function analyze(body: Record<string, unknown>): Promise<AnalyzeResponse> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) {
      continue;
    }
    q.set(k, String(v));
  }
  const res = await fetch(apiUrl(`/report/analyze?${q.toString()}`));
  if (!res.ok) {
    const text = await res.text();
    try {
      const json = JSON.parse(text) as { error?: string };
      throw new Error(json.error ?? `Analyze failed (${res.status})`);
    } catch {
      throw new Error(text || `Analyze failed (${res.status})`);
    }
  }
  return (await res.json()) as AnalyzeResponse;
}

function toOptionalNumber(value: string): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function fmtNum(v?: number): string {
  if (!Number.isFinite(v)) return '-';
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function fmtSec(sec?: number): string {
  if (!Number.isFinite(sec)) return '-';
  const t = Number(sec);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

const JOB_ID_TO_ABBR: Record<string, string> = {
  '19': 'PLD',
  '21': 'WAR',
  '32': 'DRK',
  '37': 'GNB',
  '24': 'WHM',
  '28': 'SCH',
  '33': 'AST',
  '40': 'SGE',
  '20': 'MNK',
  '22': 'DRG',
  '30': 'NIN',
  '34': 'SAM',
  '39': 'RPR',
  '41': 'VPR',
  '23': 'BRD',
  '31': 'MCH',
  '38': 'DNC',
  '25': 'BLM',
  '27': 'SMN',
  '35': 'RDM',
  '42': 'PCT'
};

const JOB_ABBR_TO_VALUE: Record<string, string> = {
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
const JOB_ID_TO_VALUE: Record<string, string> = {
  '19': 'paladin',
  '21': 'warrior',
  '32': 'darkknight',
  '37': 'gunbreaker',
  '24': 'whitemage',
  '28': 'scholar',
  '33': 'astrologian',
  '40': 'sage',
  '20': 'monk',
  '22': 'dragoon',
  '30': 'ninja',
  '34': 'samurai',
  '39': 'reaper',
  '41': 'viper',
  '23': 'bard',
  '31': 'machinist',
  '38': 'dancer',
  '25': 'blackmage',
  '27': 'summoner',
  '35': 'redmage',
  '42': 'pictomancer'
};

function toJobValue(r: RankingEntry): string {
  const spec = String(r.specName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (JOB_ABBR_TO_VALUE[spec]) {
    return JOB_ABBR_TO_VALUE[spec];
  }
  if (JOB_LABEL_BY_VALUE[spec]) {
    return spec;
  }
  const cls = String(r.className ?? '').trim().toLowerCase();
  if (JOB_ID_TO_VALUE[cls]) {
    return JOB_ID_TO_VALUE[cls];
  }
  if (JOB_ABBR_TO_VALUE[cls]) {
    return JOB_ABBR_TO_VALUE[cls];
  }
  if (JOB_LABEL_BY_VALUE[cls]) {
    return cls;
  }
  return '';
}

function toJobLabel(r: RankingEntry): string {
  const value = toJobValue(r);
  if (!value) {
    const cls = String(r.className ?? '').trim().toLowerCase();
    if (JOB_ID_TO_ABBR[cls]) return JOB_ID_TO_ABBR[cls];
    return '';
  }
  return JOB_LABEL_BY_VALUE[value] ?? value.toUpperCase();
}

function sortRankings(list: RankingEntry[]): RankingEntry[] {
  return [...list].sort((a, b) => {
    const ar = Number.isFinite(a.rank) ? Number(a.rank) : Number.POSITIVE_INFINITY;
    const br = Number.isFinite(b.rank) ? Number(b.rank) : Number.POSITIVE_INFINITY;
    if (ar !== br) {
      return ar - br;
    }
    const as = Number.isFinite(a.highestRdps) ? Number(a.highestRdps) : Number(a.amount ?? 0);
    const bs = Number.isFinite(b.highestRdps) ? Number(b.highestRdps) : Number(b.amount ?? 0);
    if (as !== bs) {
      return bs - as;
    }
    const ap = Number.isFinite(a.bestPercent) ? Number(a.bestPercent) : -1;
    const bp = Number.isFinite(b.bestPercent) ? Number(b.bestPercent) : -1;
    return bp - ap;
  });
}

export default function ReportAnalyzer() {
  const initializedRef = useRef(false);
  const autoAnalyzeTriedRef = useRef(false);

  const [mode, setMode] = useState<SourceMode>('report');

  const [reportCode, setReportCode] = useState('');
  const [strategy, setStrategy] = useState<PickStrategy>('best');
  const [onlyKill, setOnlyKill] = useState(true);
  const [difficulty, setDifficulty] = useState('101');

  const [fights, setFights] = useState<Fight[]>([]);
  const [selectedFightId, setSelectedFightId] = useState('');

  const [encounterGroups, setEncounterGroups] = useState<EncounterGroup[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState('');
  const [selectedEncounterIdInGroup, setSelectedEncounterIdInGroup] = useState('');
  const [metric, setMetric] = useState<RankingMetric>('dps');
  const [pageSize, setPageSize] = useState('10');
  const [jobFilter, setJobFilter] = useState('');
  const [rankings, setRankings] = useState<RankingEntry[]>([]);
  const [selectedRankingKey, setSelectedRankingKey] = useState('');
  const [characterName, setCharacterName] = useState('');
  const [characterServer, setCharacterServer] = useState('');
  const [characterRegion, setCharacterRegion] = useState('JP');
  const [characterCandidates, setCharacterCandidates] = useState<CharacterCandidate[]>([]);
  const [characterContents, setCharacterContents] = useState<CharacterContent[]>([]);
  const [characterReports, setCharacterReports] = useState<Array<{ code: string; title?: string; startTime?: number }>>([]);

  const [loadingFights, setLoadingFights] = useState(false);
  const [loadingAnalyze, setLoadingAnalyze] = useState(false);
  const [analyzingActionKey, setAnalyzingActionKey] = useState('');
  const [status, setStatus] = useState('Idle');
  const [error, setError] = useState('');
  const [unresolvedHint, setUnresolvedHint] = useState('');
  const [model, setModel] = useState<ViewModel | null>(null);

  const selectedZone = useMemo(
    () => encounterGroups.find((g) => String(g.zoneId) === selectedZoneId),
    [encounterGroups, selectedZoneId]
  );
  const sortedRankings = useMemo(() => sortRankings(rankings), [rankings]);

  const loadReportFights = async () => {
    setError('');
    setStatus('Loading fights list from report...');
    setLoadingFights(true);
    try {
      const list = await fetchFights(reportCode.trim());
      setFights(list);
      setSelectedFightId('');
      setStatus(`Fights loaded: ${list.length}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('Failed to load fights');
    } finally {
      setLoadingFights(false);
    }
  };

  const loadRankings = async () => {
    setError('');
    setStatus('Loading rankings...');
    setLoadingFights(true);
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      setStatus(`Loading rankings... ${sec}s`);
    }, 1000);
    try {
      const encounterIdNum = Number(selectedEncounterIdInGroup);
      const difficultyNum = Number(difficulty);
      const pageSizeNum = Number(pageSize);
      if (!Number.isFinite(encounterIdNum) || encounterIdNum <= 0) {
        throw new Error('Encounter ID must be a positive number.');
      }
      if (!Number.isFinite(difficultyNum) || difficultyNum <= 0) {
        throw new Error('Difficulty must be a positive number.');
      }
      if (!Number.isFinite(pageSizeNum) || pageSizeNum < 1 || pageSizeNum > 100) {
        throw new Error('Page Size must be between 1 and 100.');
      }

      const list = await fetchRankings({
        encounterId: encounterIdNum,
        metric,
        difficulty: difficultyNum,
        pageSize: pageSizeNum,
        job: jobFilter,
        timeoutMs: 45000
      });
      const sorted = sortRankings(list.rankings);
      setRankings(sorted);
      setSelectedRankingKey(sorted[0] ? `${sorted[0].reportCode}:${sorted[0].fightID}` : '');
      if (list.fallbackApplied) {
        if (list.resolvedEncounterId != null) {
          setSelectedEncounterIdInGroup(String(list.resolvedEncounterId));
        }
        if (list.resolvedMetric) {
          setMetric(list.resolvedMetric as RankingMetric);
        }
        if (list.resolvedDifficulty != null) {
          setDifficulty(String(list.resolvedDifficulty));
        }
        setStatus(
          `Rankings loaded with fallback: ${list.rankings.length} (encounter=${list.resolvedEncounterId}, metric=${list.resolvedMetric}, difficulty=${list.resolvedDifficulty})`
        );
      } else {
        setStatus(`Rankings loaded: ${list.rankings.length}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('Failed to load rankings');
    } finally {
      clearInterval(ticker);
      setLoadingFights(false);
    }
  };

  const loadEncounterGroups = async () => {
    setError('');
    setStatus('Loading encounter groups...');
    setLoadingFights(true);
    try {
      const groups = await fetchEncounterGroups();
      setEncounterGroups(groups);
      if (groups.length > 0) {
        const pickedEncounter = selectedEncounterIdInGroup
          ? groups.find((g) => g.encounters.some((e) => String(e.id) === selectedEncounterIdInGroup))
          : undefined;
        const zone = pickedEncounter ?? groups[0];
        setSelectedZoneId(String(zone.zoneId));
        if (!selectedEncounterIdInGroup) {
          const firstEncounter = zone.encounters[0];
          if (firstEncounter) {
            setSelectedEncounterIdInGroup(String(firstEncounter.id));
          }
        }
      }
      setStatus(`Groups loaded: ${groups.length}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('Failed to load groups');
    } finally {
      setLoadingFights(false);
    }
  };

  const loadCharacterContentsBy = async (params: { name: string; server: string; region: string }) => {
    setError('');
    setStatus('Loading character contents...');
    setLoadingFights(true);
    try {
      const data = await fetchCharacterContents({
        name: params.name.trim(),
        server: params.server.trim(),
        region: params.region.trim().toUpperCase()
      });
      setCharacterContents(data.contents);
      setCharacterReports(data.reports ?? []);
      setStatus(`Character contents loaded: ${data.contents.length}, reports: ${(data.reports ?? []).length}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('Failed to load character contents');
    } finally {
      setLoadingFights(false);
    }
  };

  const loadCharacterContents = async () => {
    await loadCharacterContentsBy({
      name: characterName,
      server: characterServer,
      region: characterRegion
    });
  };

  const searchCharacterCandidates = async () => {
    setError('');
    setStatus('Searching characters...');
    setLoadingFights(true);
    try {
      const list = await fetchCharacterCandidates({
        name: characterName.trim(),
        region: characterRegion,
        server: characterServer.trim(),
        limit: 20
      });
      setCharacterCandidates(list);
      setStatus(`Character candidates: ${list.length}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('Failed to search character');
    } finally {
      setLoadingFights(false);
    }
  };

  const runAnalyzeWithPayload = async (payload: Record<string, unknown>) => {
    setError('');
    setUnresolvedHint('');
    setStatus('Analyzing selected fight...');
    setLoadingAnalyze(true);
    try {
      const result = await analyze(payload);
      const vm = buildViewModel(result.selectedFight, result.bossTimeline, result.playersCasts);
      setModel(vm);
      const unresolved = result.unresolvedAbilityCounts ?? {};
      const unresolvedTotal = Object.keys(unresolved).length;
      if (unresolvedTotal > 0) {
        const top = Object.entries(unresolved)
          .slice(0, 5)
          .map(([id, c]) => `${id}(${c})`)
          .join(', ');
        setUnresolvedHint(
          `未解決 ability: ${unresolvedTotal}件 (top: ${top})。必要なら out/ability_overrides.json で上書きしてください。`
        );
      }
      setStatus(
        `Analyze completed: fight=${result.selectedFight.fightID}, players=${Object.keys(result.playersCasts).length}, unresolved=${unresolvedTotal}`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('Analyze failed');
    } finally {
      setLoadingAnalyze(false);
    }
  };

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const qpMode = params.get('mode');
    if (qpMode === 'report' || qpMode === 'rankings' || qpMode === 'character') {
      setMode(qpMode);
    }

    const qpReport = params.get('report');
    if (qpReport) {
      setReportCode(qpReport);
    }

    const qpStrategy = params.get('strategy');
    if (qpStrategy === 'best' || qpStrategy === 'lastKill' || qpStrategy === 'firstKill' || qpStrategy === 'longest') {
      setStrategy(qpStrategy);
    }

    const qpOnlyKill = params.get('onlyKill');
    if (qpOnlyKill != null) {
      setOnlyKill(qpOnlyKill === 'true');
    }

    const qpDifficulty = params.get('difficulty');
    if (qpDifficulty) {
      setDifficulty(qpDifficulty);
    }

    const qpFightId = params.get('fightId');
    if (qpFightId) {
      setSelectedFightId(qpFightId);
    }

    const qpEncounterId = params.get('encounterId');
    if (qpEncounterId) {
      setSelectedEncounterIdInGroup(qpEncounterId);
    }

    const qpMetric = params.get('metric');
    if (qpMetric === 'dps' || qpMetric === 'rdps' || qpMetric === 'hps' || qpMetric === 'bossdps') {
      setMetric(qpMetric);
    }

    const qpPageSize = params.get('pageSize');
    if (qpPageSize) {
      setPageSize(qpPageSize);
    }
    const qpJob = params.get('job');
    if (qpJob) {
      setJobFilter(qpJob);
    }

    const qpRankingKey = params.get('rankingKey');
    if (qpRankingKey) {
      setSelectedRankingKey(qpRankingKey);
    }

    const qpCharacterName = params.get('characterName');
    if (qpCharacterName) {
      setCharacterName(qpCharacterName);
    }
    const qpCharacterServer = params.get('characterServer');
    if (qpCharacterServer) {
      setCharacterServer(qpCharacterServer);
    }
    const qpCharacterRegion = params.get('characterRegion');
    if (qpCharacterRegion) {
      setCharacterRegion(qpCharacterRegion.toUpperCase());
    }
  }, []);

  useEffect(() => {
    if (!initializedRef.current || autoAnalyzeTriedRef.current) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const qpMode = params.get('mode') ?? 'report';

    if (qpMode === 'report') {
      const qpReport = params.get('report')?.trim();
      if (!qpReport) {
        return;
      }
      autoAnalyzeTriedRef.current = true;
      void runAnalyzeWithPayload({
        reportCode: qpReport,
        strategy: params.get('strategy') ?? 'best',
        onlyKill: params.get('onlyKill') !== 'false',
        difficulty: toOptionalNumber(params.get('difficulty') ?? ''),
        fightId: toOptionalNumber(params.get('fightId') ?? ''),
        translate: true,
        locale: 'ja',
        xivapiFallback: true,
        xivapiLang: 'ja'
      });
      return;
    }

    if (qpMode === 'rankings') {
      const rankingKey = params.get('rankingKey');
      if (!rankingKey) {
        return;
      }
      const [rc, fid] = rankingKey.split(':');
      const fightId = toOptionalNumber(fid ?? '');
      if (!rc || !fightId) {
        return;
      }
      autoAnalyzeTriedRef.current = true;
      void runAnalyzeWithPayload({
        reportCode: rc,
        strategy: 'best',
        onlyKill: params.get('onlyKill') !== 'false',
        difficulty: toOptionalNumber(params.get('difficulty') ?? ''),
        fightId,
        translate: true,
        locale: 'ja',
        xivapiFallback: true,
        xivapiLang: 'ja'
      });
    }
  }, []);

  useEffect(() => {
    if (!initializedRef.current) {
      return;
    }
    const q = new URLSearchParams();
    q.set('mode', mode);
    q.set('onlyKill', String(onlyKill));
    if (difficulty) {
      q.set('difficulty', difficulty);
    }

    if (mode === 'report') {
      if (reportCode.trim()) {
        q.set('report', reportCode.trim());
      }
      q.set('strategy', strategy);
      if (selectedFightId) {
        q.set('fightId', selectedFightId);
      }
    } else {
      if (mode === 'rankings') {
        if (selectedEncounterIdInGroup) {
          q.set('encounterId', selectedEncounterIdInGroup);
        }
        q.set('metric', metric);
        if (pageSize) {
          q.set('pageSize', pageSize);
        }
        if (jobFilter.trim()) {
          q.set('job', jobFilter.trim());
        }
        if (selectedRankingKey) {
          q.set('rankingKey', selectedRankingKey);
        }
      } else {
        if (characterName.trim()) {
          q.set('characterName', characterName.trim());
        }
        if (characterServer.trim()) {
          q.set('characterServer', characterServer.trim());
        }
        if (characterRegion) {
          q.set('characterRegion', characterRegion);
        }
      }
    }

    const query = q.toString();
    const base = window.location.pathname;
    const next = query ? `${base}?${query}` : base;
    const current = `${window.location.pathname}${window.location.search}`;
    if (next !== current) {
      window.history.replaceState(null, '', next);
    }
  }, [
    mode,
    reportCode,
    strategy,
    onlyKill,
    difficulty,
    selectedFightId,
    selectedEncounterIdInGroup,
    metric,
    pageSize,
    jobFilter,
    selectedRankingKey,
    characterName,
    characterServer,
    characterRegion
  ]);

  useEffect(() => {
    if (mode !== 'rankings') {
      return;
    }
    if (encounterGroups.length > 0 || loadingFights || loadingAnalyze) {
      return;
    }
    void loadEncounterGroups();
  }, [mode]);

  useEffect(() => {
    if (characterServer) {
      return;
    }
    const first = SERVER_OPTIONS[characterRegion]?.[0];
    if (first) {
      setCharacterServer(first);
    }
  }, [characterRegion, characterServer]);

  return (
    <>
      <section className="controls analyzerTop">
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as SourceMode)}>
            <option value="report">Report</option>
            <option value="rankings">Rankings</option>
            <option value="character">Character</option>
          </select>
        </label>

        {mode === 'report' ? (
          <>
            <label className="searchBox">
              Report Code
              <input value={reportCode} onChange={(e) => setReportCode(e.target.value)} placeholder="HpRq1BmMvwh7PVGa" />
            </label>
            <button onClick={loadReportFights} disabled={!reportCode || loadingFights || loadingAnalyze}>
              {loadingFights ? 'Fetching fights...' : 'Fetch Fight List'}
            </button>
            <label>
              Pick
              <select value={strategy} onChange={(e) => setStrategy(e.target.value as PickStrategy)}>
                <option value="best">best</option>
                <option value="lastKill">lastKill</option>
                <option value="firstKill">firstKill</option>
                <option value="longest">longest</option>
              </select>
            </label>
          </>
        ) : mode === 'rankings' ? (
          <>
            <label>
              Zone
              <select
                value={selectedZoneId}
                onChange={(e) => {
                  const nextZoneId = e.target.value;
                  setSelectedZoneId(nextZoneId);
                  const nextZone = encounterGroups.find((g) => String(g.zoneId) === nextZoneId);
                  setSelectedEncounterIdInGroup(nextZone?.encounters[0] ? String(nextZone.encounters[0].id) : '');
                }}
              >
                <option value="">Select zone</option>
                {encounterGroups.map((g) => (
                  <option key={g.zoneId} value={String(g.zoneId)}>
                    {g.zoneName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Encounter
              <select
                value={selectedEncounterIdInGroup}
                onChange={(e) => {
                  setSelectedEncounterIdInGroup(e.target.value);
                }}
              >
                <option value="">Select encounter</option>
                {(selectedZone?.encounters ?? []).map((enc) => (
                  <option key={enc.id} value={String(enc.id)}>
                    {enc.name} ({enc.id})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Metric
              <select value={metric} onChange={(e) => setMetric(e.target.value as RankingMetric)}>
                <option value="dps">dps</option>
                <option value="rdps">rdps</option>
                <option value="hps">hps</option>
                <option value="bossdps">bossdps</option>
              </select>
            </label>
            <label>
              Job
              <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)}>
                {JOB_OPTIONS.map((job) => (
                  <option key={job.value || 'all'} value={job.value}>
                    {job.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Page Size
              <input value={pageSize} onChange={(e) => setPageSize(e.target.value)} placeholder="10" />
            </label>
            <button
              onClick={loadRankings}
              disabled={!selectedEncounterIdInGroup || !difficulty || !metric || loadingFights || loadingAnalyze}
            >
              {loadingFights ? 'Fetching rankings...' : 'Fetch Rankings'}
            </button>
          </>
        ) : (
          <>
            <label>
              Character Name
              <input value={characterName} onChange={(e) => setCharacterName(e.target.value)} placeholder="キャラ名" />
            </label>
            <label>
              Region
              <select
                value={characterRegion}
                onChange={(e) => {
                  const region = e.target.value;
                  setCharacterRegion(region);
                  const first = SERVER_OPTIONS[region]?.[0] ?? '';
                  setCharacterServer(first);
                }}
              >
                <option value="JP">JP</option>
                <option value="US">US</option>
                <option value="EU">EU</option>
                <option value="KR">KR</option>
                <option value="OC">OC</option>
              </select>
            </label>
            <label>
              Server
              <select value={characterServer} onChange={(e) => setCharacterServer(e.target.value)}>
                <option value="">Select server</option>
                {(SERVER_OPTIONS[characterRegion] ?? []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={searchCharacterCandidates}
              disabled={!characterName.trim() || loadingFights || loadingAnalyze}
            >
              {loadingFights ? 'Searching characters...' : 'Search Character'}
            </button>
            <button
              onClick={loadCharacterContents}
              disabled={!characterName.trim() || !characterServer.trim() || loadingFights || loadingAnalyze}
            >
              {loadingFights ? 'Fetching contents...' : 'Fetch Contents'}
            </button>
          </>
        )}

        <label>
          Difficulty
          <input value={difficulty} onChange={(e) => setDifficulty(e.target.value)} placeholder="101" />
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyKill} onChange={(e) => setOnlyKill(e.target.checked)} />
          onlyKill
        </label>
      </section>

      <p className="helpText">
        Rankings/Report は各行の `Analyze` で即実行できます。Character は `Use & Fetch` で即コンテンツ取得できます。
      </p>

      <p className={`loadingStatus ${loadingFights || loadingAnalyze ? 'active' : ''}`} role="status" aria-live="polite">
        {loadingFights || loadingAnalyze ? <span className="spinner" aria-hidden="true" /> : null}
        <span>{loadingFights || loadingAnalyze ? 'Processing' : 'Ready'}</span>
        {loadingFights || loadingAnalyze ? <span className="loadingDots" aria-hidden="true" /> : null}
        <span>{status}</span>
      </p>

      {error ? <p className="errorMsg">{error}</p> : null}
      {unresolvedHint ? <p className="warnMsg">{unresolvedHint}</p> : null}

      {mode === 'report' && fights.length > 0 ? (
        <section className="tableWrap fightsWrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Kill</th>
                <th>Difficulty</th>
                <th>Duration(s)</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {fights.map((f) => (
                <tr key={f.id}>
                  <td>{f.id}</td>
                  <td>{f.name}</td>
                  <td>{String(f.kill)}</td>
                  <td>{f.difficulty ?? '-'}</td>
                  <td>{((f.endTime - f.startTime) / 1000).toFixed(1)}</td>
                  <td>
                    <button
                      className={`analyzeBtn ${loadingAnalyze && analyzingActionKey === `report:${f.id}` ? 'loading' : ''}`}
                      type="button"
                      disabled={loadingAnalyze || loadingFights}
                      onClick={async () => {
                        const actionKey = `report:${f.id}`;
                        setAnalyzingActionKey(actionKey);
                        setSelectedFightId(String(f.id));
                        try {
                          await runAnalyzeWithPayload({
                            reportCode: reportCode.trim(),
                            strategy,
                            onlyKill,
                            difficulty: difficulty ? Number(difficulty) : undefined,
                            fightId: f.id,
                            translate: true,
                            locale: 'ja',
                            xivapiFallback: true,
                            xivapiLang: 'ja'
                          });
                        } finally {
                          setAnalyzingActionKey('');
                        }
                      }}
                    >
                      {loadingAnalyze && analyzingActionKey === `report:${f.id}` ? (
                        <span className="btnLoadingContent">
                          <span className="spinner" aria-hidden="true" />
                          Analyzing...
                        </span>
                      ) : (
                        'Analyze'
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {mode === 'rankings' && sortedRankings.length > 0 ? (
        <section className="tableWrap fightsWrap">
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Character</th>
                <th>Job</th>
                <th>Best %</th>
                <th>Highest rDPS</th>
                <th>Kill</th>
                <th>Fastest</th>
                <th>Med</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {sortedRankings.map((r, idx) => {
                const key = `${r.reportCode}:${r.fightID}`;
                const rowKey = `${key}:${r.rank}:${r.characterName ?? '-'}:${idx}`;
                return (
                  <tr key={rowKey}>
                    <td>{r.rank}</td>
                    <td>{r.characterName ?? '-'}</td>
                    <td>{toJobLabel(r) || '-'}</td>
                    <td>{fmtNum(r.bestPercent)}</td>
                    <td>{fmtNum(r.highestRdps ?? r.amount)}</td>
                    <td>{r.kill == null ? '-' : r.kill ? 'Yes' : 'No'}</td>
                    <td>{fmtSec(r.fastestSec)}</td>
                    <td>{fmtNum(r.medianRdps)}</td>
                    <td>
                      <button
                        className={`analyzeBtn ${loadingAnalyze && analyzingActionKey === `ranking:${key}` ? 'loading' : ''}`}
                        type="button"
                        disabled={loadingAnalyze || loadingFights}
                        onClick={async () => {
                          const actionKey = `ranking:${key}`;
                          setAnalyzingActionKey(actionKey);
                          setSelectedRankingKey(key);
                          try {
                            await runAnalyzeWithPayload({
                              reportCode: r.reportCode,
                              fightId: r.fightID,
                              strategy: 'best',
                              onlyKill,
                              difficulty: Number(difficulty),
                              translate: true,
                              locale: 'ja',
                              xivapiFallback: true,
                              xivapiLang: 'ja'
                            });
                          } finally {
                            setAnalyzingActionKey('');
                          }
                        }}
                      >
                        {loadingAnalyze && analyzingActionKey === `ranking:${key}` ? (
                          <span className="btnLoadingContent">
                            <span className="spinner" aria-hidden="true" />
                            Analyzing...
                          </span>
                        ) : (
                          'Analyze'
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}

      {mode === 'character' && characterContents.length > 0 ? (
        <section className="tableWrap fightsWrap">
          <table>
            <thead>
              <tr>
                <th>Zone</th>
                <th>Encounter</th>
                <th>Best %</th>
                <th>Total Kills</th>
                <th>Use</th>
              </tr>
            </thead>
            <tbody>
              {characterContents.map((row) => (
                <tr key={`${row.zoneId}:${row.encounterId}`}>
                  <td>{row.zoneName || row.zoneId}</td>
                  <td>
                    {row.encounterName} ({row.encounterId})
                  </td>
                  <td>{Number.isFinite(row.bestPercent) ? row.bestPercent.toFixed(1) : '-'}</td>
                  <td>{Number.isFinite(row.totalKills) ? row.totalKills : '-'}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedEncounterIdInGroup(String(row.encounterId));
                        setMode('rankings');
                      }}
                    >
                      Use in Rankings
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {mode === 'character' && characterContents.length === 0 && characterReports.length > 0 ? (
        <section className="tableWrap fightsWrap">
          <table>
            <thead>
              <tr>
                <th>Recent Report</th>
                <th>Title</th>
                <th>Use</th>
              </tr>
            </thead>
            <tbody>
              {characterReports.map((r) => (
                <tr key={r.code}>
                  <td>{r.code}</td>
                  <td>{r.title ?? '-'}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => {
                        setMode('report');
                        setReportCode(r.code);
                      }}
                    >
                      Open in Report
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {mode === 'character' && characterCandidates.length > 0 ? (
        <section className="tableWrap fightsWrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Server</th>
                <th>Region</th>
                <th>Use</th>
              </tr>
            </thead>
            <tbody>
              {characterCandidates.map((row) => (
                <tr key={`${row.name}:${row.serverSlug}:${row.region}`}>
                  <td>{row.name}</td>
                  <td>{row.serverSlug}</td>
                  <td>{row.region}</td>
                  <td>
                    <button
                      type="button"
                      onClick={async () => {
                        setCharacterName(row.name);
                        setCharacterRegion(row.region || characterRegion);
                        setCharacterServer(row.serverSlug);
                        await loadCharacterContentsBy({
                          name: row.name,
                          region: row.region || characterRegion,
                          server: row.serverSlug
                        });
                      }}
                    >
                      Use & Fetch
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {model ? <TimelineGrid model={model} /> : null}
    </>
  );
}
