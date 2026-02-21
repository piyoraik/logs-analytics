'use client';

import { useEffect, useMemo, useState } from 'react';
import TimelineGrid from './TimelineGrid';
import { buildViewModel } from '../../lib/transform';
import { ViewModel } from '../../lib/types';

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');
const USE_NEXT_API = process.env.NEXT_PUBLIC_USE_NEXT_API !== 'false';

type PickStrategy = 'best' | 'lastKill' | 'firstKill' | 'longest';

interface AnalyzeResponse {
  selectedFight: any;
  bossTimeline: any[];
  playersCasts: Record<string, any[]>;
}

function apiUrl(path: string): string {
  if (USE_NEXT_API) {
    return `/api${path}`;
  }
  if (!API_BASE_URL) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL is not set.');
  }
  return `${API_BASE_URL}${path}`;
}

function toOptionalNumber(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export default function TimelineOnly() {
  const [model, setModel] = useState<ViewModel | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const [reportCode, setReportCode] = useState('');
  const [fightId, setFightId] = useState('');
  const [strategy, setStrategy] = useState<PickStrategy>('best');
  const [difficulty, setDifficulty] = useState('101');
  const [onlyKill, setOnlyKill] = useState(true);

  const query = useMemo(() => {
    if (typeof window === 'undefined') return new URLSearchParams();
    return new URLSearchParams(window.location.search);
  }, []);

  useEffect(() => {
    const qpReportCode = query.get('reportCode')?.trim() ?? '';
    const qpFightId = query.get('fightId') ?? '';
    const qpDifficulty = query.get('difficulty') ?? '101';
    const qpStrategy = query.get('strategy');
    const qpOnlyKill = query.get('onlyKill');

    setReportCode(qpReportCode);
    setFightId(qpFightId);
    setDifficulty(qpDifficulty);
    if (qpStrategy === 'best' || qpStrategy === 'lastKill' || qpStrategy === 'firstKill' || qpStrategy === 'longest') {
      setStrategy(qpStrategy);
    }
    setOnlyKill(qpOnlyKill == null ? true : qpOnlyKill === 'true');
  }, [query]);

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      setError('');
      setModel(null);
      try {
        const code = query.get('reportCode')?.trim();
        if (!code) {
          throw new Error('reportCode is required.');
        }
        const q = new URLSearchParams();
        q.set('reportCode', code);
        q.set('strategy', query.get('strategy') ?? 'best');
        q.set('onlyKill', query.get('onlyKill') ?? 'true');
        q.set('translate', 'true');
        q.set('locale', 'ja');
        q.set('xivapiFallback', 'true');
        q.set('xivapiLang', 'ja');

        const queryFightId = toOptionalNumber(query.get('fightId'));
        const queryDifficulty = toOptionalNumber(query.get('difficulty'));
        if (queryFightId != null) q.set('fightId', String(queryFightId));
        if (queryDifficulty != null) q.set('difficulty', String(queryDifficulty));

        const res = await fetch(apiUrl(`/report/analyze?${q.toString()}`));
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Analyze failed (${res.status})`);
        }
        const json = (await res.json()) as AnalyzeResponse;
        setModel(buildViewModel(json.selectedFight, json.bossTimeline, json.playersCasts));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [query]);

  return (
    <>
      <section className="controls timelineSearchControls">
        <p className="helpText">表示条件を編集して「再表示」を押すと、このページのタイムラインが切り替わります。</p>
        <label className="searchBox">
          Report Code
          <input value={reportCode} onChange={(e) => setReportCode(e.target.value)} placeholder="HpRq1BmMvwh7PVGa" />
        </label>
        <label>
          Fight ID（任意）
          <input value={fightId} onChange={(e) => setFightId(e.target.value)} placeholder="未指定なら自動選択" />
        </label>
        <label>
          自動選択ルール
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as PickStrategy)}>
            <option value="best">best</option>
            <option value="lastKill">lastKill</option>
            <option value="firstKill">firstKill</option>
            <option value="longest">longest</option>
          </select>
        </label>
        <label>
          Difficulty
          <input value={difficulty} onChange={(e) => setDifficulty(e.target.value)} placeholder="101" />
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyKill} onChange={(e) => setOnlyKill(e.target.checked)} />
          Killのみ対象
        </label>
        <button
          className="btn btnPrimary"
          type="button"
          onClick={() => {
            const q = new URLSearchParams();
            if (reportCode.trim()) q.set('reportCode', reportCode.trim());
            if (fightId.trim()) q.set('fightId', fightId.trim());
            if (difficulty.trim()) q.set('difficulty', difficulty.trim());
            q.set('strategy', strategy);
            q.set('onlyKill', String(onlyKill));
            window.location.href = `/timeline?${q.toString()}`;
          }}
          disabled={!reportCode.trim()}
          title="この条件を適用"
        >
          <span className="btnIcon" aria-hidden="true">⟳</span>
          <span className="btnLabel">適用</span>
        </button>
      </section>

      {loading ? (
        <p className="loadingStatus active" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>処理中</span>
          <span className="loadingDots" aria-hidden="true" />
          <span>タイムラインを読み込み中...</span>
        </p>
      ) : null}
      {error ? <p className="errorMsg">{error}</p> : null}
      {!loading && !error && !model ? <p className="warnMsg">タイムラインデータがありません。条件を変更して再実行してください。</p> : null}
      {!loading && !error && model ? <TimelineGrid model={model} /> : null}
    </>
  );
}
