'use client';

import { useEffect, useMemo, useState } from 'react';
import TimelineGrid from './TimelineGrid';
import { buildViewModel } from '../../lib/transform';
import { Fight, ViewModel } from '../../lib/types';

type PickStrategy = 'best' | 'lastKill' | 'firstKill' | 'longest';
type SourceMode = 'report' | 'rankings';
type RankingMetric = 'dps' | 'rdps' | 'hps' | 'bossdps';

interface RankingEntry {
  rank: number;
  amount: number;
  reportCode: string;
  fightID: number;
  characterName?: string;
  serverName?: string;
  region?: string;
  className?: string;
  specName?: string;
}

interface EncounterCandidate {
  id: number;
  name: string;
  zoneId?: number;
  zoneName?: string;
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

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');

function apiUrl(path: string): string {
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
  timeoutMs?: number;
}): Promise<RankingsFetchResponse> {
  const q = new URLSearchParams({
    encounterId: String(params.encounterId),
    metric: params.metric,
    difficulty: String(params.difficulty),
    pageSize: String(params.pageSize)
  });

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

async function fetchEncounterCandidates(keyword: string): Promise<EncounterCandidate[]> {
  const res = await fetch(apiUrl(`/encounters/search?q=${encodeURIComponent(keyword)}&max=40`));
  if (!res.ok) {
    throw new Error((await res.json()).error ?? 'Failed to search encounters');
  }
  const json = (await res.json()) as { encounters: EncounterCandidate[] };
  return json.encounters;
}

async function fetchEncounterGroups(): Promise<EncounterGroup[]> {
  const res = await fetch(apiUrl('/encounters/groups'));
  if (!res.ok) {
    throw new Error((await res.json()).error ?? 'Failed to load encounter groups');
  }
  const json = (await res.json()) as { groups: EncounterGroup[] };
  return json.groups;
}

async function analyze(body: Record<string, unknown>): Promise<AnalyzeResponse> {
  const res = await fetch(apiUrl('/report/analyze'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error((await res.json()).error ?? 'Analyze failed');
  }
  return (await res.json()) as AnalyzeResponse;
}

export default function ReportAnalyzer() {
  const [mode, setMode] = useState<SourceMode>('report');

  const [reportCode, setReportCode] = useState('');
  const [strategy, setStrategy] = useState<PickStrategy>('best');
  const [onlyKill, setOnlyKill] = useState(true);
  const [difficulty, setDifficulty] = useState('101');

  const [fights, setFights] = useState<Fight[]>([]);
  const [selectedFightId, setSelectedFightId] = useState('');

  const [encounterId, setEncounterId] = useState('');
  const [encounterGroups, setEncounterGroups] = useState<EncounterGroup[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState('');
  const [selectedEncounterIdInGroup, setSelectedEncounterIdInGroup] = useState('');
  const [encounterKeyword, setEncounterKeyword] = useState('');
  const [encounterCandidates, setEncounterCandidates] = useState<EncounterCandidate[]>([]);
  const [metric, setMetric] = useState<RankingMetric>('dps');
  const [pageSize, setPageSize] = useState('10');
  const [rankings, setRankings] = useState<RankingEntry[]>([]);
  const [selectedRankingKey, setSelectedRankingKey] = useState('');

  const [loadingFights, setLoadingFights] = useState(false);
  const [loadingAnalyze, setLoadingAnalyze] = useState(false);
  const [status, setStatus] = useState('Idle');
  const [error, setError] = useState('');
  const [unresolvedHint, setUnresolvedHint] = useState('');
  const [model, setModel] = useState<ViewModel | null>(null);

  const selectedFight = useMemo(() => {
    const id = Number(selectedFightId);
    if (!Number.isFinite(id)) {
      return undefined;
    }
    return fights.find((f) => f.id === id);
  }, [fights, selectedFightId]);

  const selectedRanking = useMemo(() => {
    return rankings.find((r) => `${r.reportCode}:${r.fightID}` === selectedRankingKey);
  }, [rankings, selectedRankingKey]);

  const selectedZone = useMemo(
    () => encounterGroups.find((g) => String(g.zoneId) === selectedZoneId),
    [encounterGroups, selectedZoneId]
  );

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
      const encounterIdNum = Number(encounterId);
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
        timeoutMs: 45000
      });
      setRankings(list.rankings);
      setSelectedRankingKey(list.rankings[0] ? `${list.rankings[0].reportCode}:${list.rankings[0].fightID}` : '');
      if (list.fallbackApplied) {
        if (list.resolvedEncounterId != null) {
          setEncounterId(String(list.resolvedEncounterId));
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

  const searchEncounter = async () => {
    setError('');
    setStatus('Searching encounters...');
    setLoadingFights(true);
    try {
      const list = await fetchEncounterCandidates(encounterKeyword.trim());
      setEncounterCandidates(list);
      setStatus(`Encounter candidates: ${list.length}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('Failed to search encounters');
    } finally {
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
      if (groups[0]) {
        setSelectedZoneId(String(groups[0].zoneId));
      }
      setStatus(`Groups loaded: ${groups.length}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('Failed to load groups');
    } finally {
      setLoadingFights(false);
    }
  };

  const runAnalyze = async () => {
    setError('');
    setUnresolvedHint('');
    setStatus('Analyzing selected fight...');
    setLoadingAnalyze(true);
    try {
      const payload =
        mode === 'report'
          ? {
              reportCode: reportCode.trim(),
              strategy,
              onlyKill,
              difficulty: difficulty ? Number(difficulty) : undefined,
              fightId: selectedFight ? selectedFight.id : undefined,
              translate: true,
              locale: 'ja',
              xivapiFallback: true,
              xivapiLang: 'ja'
            }
          : {
              reportCode: selectedRanking?.reportCode,
              fightId: selectedRanking?.fightID,
              strategy: 'best',
              onlyKill,
              difficulty: Number(difficulty),
              translate: true,
              locale: 'ja',
              xivapiFallback: true,
              xivapiLang: 'ja'
            };

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
    if (mode !== 'rankings') {
      return;
    }
    if (encounterGroups.length > 0 || loadingFights || loadingAnalyze) {
      return;
    }
    void loadEncounterGroups();
  }, [mode]);

  return (
    <>
      <section className="controls analyzerTop">
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as SourceMode)}>
            <option value="report">Report</option>
            <option value="rankings">Rankings</option>
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
        ) : (
          <>
            <label>
              Encounter ID
              <input value={encounterId} onChange={(e) => setEncounterId(e.target.value)} placeholder="123" />
            </label>
            <label>
              Zone
              <select
                value={selectedZoneId}
                onChange={(e) => {
                  setSelectedZoneId(e.target.value);
                  setSelectedEncounterIdInGroup('');
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
                  setEncounterId(e.target.value);
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
            <label className="searchBox">
              Encounter Name
              <input
                value={encounterKeyword}
                onChange={(e) => setEncounterKeyword(e.target.value)}
                placeholder="Vamp Fatale"
              />
            </label>
            <button onClick={searchEncounter} disabled={!encounterKeyword || loadingFights || loadingAnalyze}>
              {loadingFights ? 'Searching...' : 'Find Encounter'}
            </button>
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
              Page Size
              <input value={pageSize} onChange={(e) => setPageSize(e.target.value)} placeholder="10" />
            </label>
            <button
              onClick={loadRankings}
              disabled={!encounterId || !difficulty || !metric || loadingFights || loadingAnalyze}
            >
              {loadingFights ? 'Fetching rankings...' : 'Fetch Rankings'}
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
        <button
          onClick={runAnalyze}
          disabled={
            mode === 'report'
              ? !reportCode || loadingAnalyze
              : !selectedRanking || loadingAnalyze
          }
        >
          {loadingAnalyze ? 'Running analysis...' : 'Run Analysis'}
        </button>
      </section>

      <p className="helpText">
        `Fetch ...` は一覧の取得のみです。`Run Analysis` は選択したfightのイベントを取得して、タイムライン/集計を生成します。
      </p>

      <p className={`loadingStatus ${loadingFights || loadingAnalyze ? 'active' : ''}`}>
        {loadingFights || loadingAnalyze ? 'Processing...' : 'Ready'} {status}
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
                <th>Select</th>
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
                    <input
                      type="radio"
                      checked={selectedFightId === String(f.id)}
                      onChange={() => setSelectedFightId(String(f.id))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {mode === 'rankings' && rankings.length > 0 ? (
        <section className="tableWrap fightsWrap">
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Amount</th>
                <th>Report</th>
                <th>Fight</th>
                <th>Character</th>
                <th>Select</th>
              </tr>
            </thead>
            <tbody>
              {rankings.map((r, idx) => {
                const key = `${r.reportCode}:${r.fightID}`;
                const rowKey = `${key}:${r.rank}:${r.characterName ?? '-'}:${idx}`;
                return (
                  <tr key={rowKey}>
                    <td>{r.rank}</td>
                    <td>{r.amount}</td>
                    <td>{r.reportCode}</td>
                    <td>{r.fightID}</td>
                    <td>{r.characterName ?? '-'}</td>
                    <td>
                      <input
                        type="radio"
                        checked={selectedRankingKey === key}
                        onChange={() => setSelectedRankingKey(key)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}

      {mode === 'rankings' && encounterCandidates.length > 0 ? (
        <section className="tableWrap fightsWrap">
          <table>
            <thead>
              <tr>
                <th>Encounter ID</th>
                <th>Encounter</th>
                <th>Zone</th>
                <th>Use</th>
              </tr>
            </thead>
            <tbody>
              {encounterCandidates.map((e) => (
                <tr key={`${e.id}-${e.zoneId ?? 0}`}>
                  <td>{e.id}</td>
                  <td>{e.name}</td>
                  <td>{e.zoneName ?? '-'}</td>
                  <td>
                    <button type="button" onClick={() => setEncounterId(String(e.id))}>
                      Set ID
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
