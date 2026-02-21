'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AbilityUse, GridRow, ViewModel } from '../../lib/types';

interface Props {
  model: ViewModel;
}

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');
const USE_NEXT_API =
  process.env.NEXT_PUBLIC_USE_NEXT_API === 'true' ||
  (process.env.NEXT_PUBLIC_USE_NEXT_API !== 'false' && !API_BASE_URL);

function apiUrl(path: string): string {
  if (USE_NEXT_API) {
    return `/api${path}`;
  }
  if (!API_BASE_URL) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL is not set.');
  }
  return `${API_BASE_URL}${path}`;
}

function rowHasAnyContent(row: GridRow, visiblePlayers: string[]): boolean {
  if (row.boss.length > 0) {
    return true;
  }
  return visiblePlayers.some((p) => (row.players[p] ?? []).length > 0);
}

function formatTimelineTime(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function fetchIconChunk(ids: number[], lang: string): Promise<Record<string, string>> {
  if (ids.length === 0) {
    return {};
  }
  const q = encodeURIComponent(ids.join(','));
  const res = await fetch(apiUrl(`/ability-icons?ids=${q}&lang=${encodeURIComponent(lang)}`));
  if (!res.ok) {
    return {};
  }
  const json = (await res.json()) as { icons?: Record<string, string> };
  return json.icons ?? {};
}

function AbilityCell({
  list,
  iconMap
}: {
  list: AbilityUse[];
  iconMap: Record<string, string>;
}) {
  if (list.length === 0) {
    return <span className="dash">-</span>;
  }

  return (
    <div className="abilityList">
      {list.map((x, i) => {
        const icon = iconMap[String(x.abilityId)];

        return (
          <span key={`${x.abilityId}-${i}`} className="abilityItem">
            {icon ? (
              <img
                className="abilityIcon"
                src={icon}
                alt={x.ability}
                title={`${x.ability} [${x.abilityId}]`}
                loading="lazy"
                decoding="async"
              />
            ) : null}
            <span>{`${x.ability} [${x.abilityId}]`}</span>
          </span>
        );
      })}
    </div>
  );
}

export default function TimelineGrid({ model }: Props) {
  const [timeStepSec, setTimeStepSec] = useState(1);
  const [enabledPlayers, setEnabledPlayers] = useState<Record<string, boolean>>(
    Object.fromEntries(model.players.map((p) => [p, true]))
  );
  const [iconMap, setIconMap] = useState<Record<string, string>>({});
  const [iconLoading, setIconLoading] = useState(false);
  const requestedIconIdsRef = useRef<Set<number>>(new Set());
  const [colWidths, setColWidths] = useState<Record<string, number>>({
    time: 96,
    boss: 360
  });

  const visiblePlayers = useMemo(
    () => model.players.filter((p) => enabledPlayers[p]),
    [model.players, enabledPlayers]
  );
  const columnKeys = useMemo(() => ['time', 'boss', ...visiblePlayers], [visiblePlayers]);

  const filteredRows = useMemo(() => {
    return model.rows.filter((row) => rowHasAnyContent(row, visiblePlayers));
  }, [model.rows, visiblePlayers]);

  const displayedRows = useMemo(() => {
    if (timeStepSec <= 1) {
      return filteredRows;
    }
    const buckets = new Map<number, GridRow>();
    for (const row of filteredRows) {
      const bucket = Math.floor(row.second / timeStepSec) * timeStepSec;
      const current = buckets.get(bucket) ?? { second: bucket, boss: [], players: {} };
      current.boss.push(...row.boss);
      for (const player of visiblePlayers) {
        const events = row.players[player] ?? [];
        if (events.length === 0) {
          continue;
        }
        const prev = current.players[player] ?? [];
        prev.push(...events);
        current.players[player] = prev;
      }
      buckets.set(bucket, current);
    }
    return [...buckets.values()].sort((a, b) => a.second - b.second);
  }, [filteredRows, timeStepSec, visiblePlayers]);

  const handleResizeStart = (columnKey: string, startX: number) => {
    const current = colWidths[columnKey] ?? (columnKey === 'time' ? 96 : 320);
    const minWidth = columnKey === 'time' ? 72 : 180;
    const maxWidth = 1200;
    const speed = columnKey === 'boss' ? 1.35 : 1;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      const delta = (ev.clientX - startX) * speed;
      const next = Math.max(minWidth, Math.min(maxWidth, current + delta));
      setColWidths((prev) => ({ ...prev, [columnKey]: next }));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const missingIconIds = useMemo(() => {
    const ids = new Set<number>();
    for (const row of displayedRows) {
      for (const e of row.boss) {
        if (!iconMap[String(e.abilityId)]) {
          ids.add(e.abilityId);
        }
      }
      for (const player of visiblePlayers) {
        for (const e of row.players[player] ?? []) {
          if (!iconMap[String(e.abilityId)]) {
            ids.add(e.abilityId);
          }
        }
      }
    }
    return [...ids];
  }, [displayedRows, visiblePlayers, iconMap]);

  useEffect(() => {
    const targets = missingIconIds.filter((id) => !requestedIconIdsRef.current.has(id));
    if (targets.length === 0) {
      return;
    }
    for (const id of targets) {
      requestedIconIdsRef.current.add(id);
    }

    const chunks: number[][] = [];
    for (let i = 0; i < targets.length; i += 120) {
      chunks.push(targets.slice(i, i + 120));
    }

    let mounted = true;
    setIconLoading(true);
    Promise.allSettled(
      chunks.map(async (chunk) => {
        const icons = await fetchIconChunk(chunk, 'ja');
        if (!mounted || Object.keys(icons).length === 0) {
          return;
        }
        setIconMap((prev) => ({ ...prev, ...icons }));
      })
    )
      .finally(() => {
        if (mounted) {
          setIconLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [missingIconIds]);

  return (
    <>
      <section className="timelineBar">
        <label className="timelineSetting">
          Time Step(s)
          <select value={timeStepSec} onChange={(e) => setTimeStepSec(Number(e.target.value))}>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={5}>5</option>
            <option value={10}>10</option>
          </select>
        </label>
        <span className="status">
          {iconLoading ? <span className="spinner" aria-hidden="true" /> : null}
          {iconLoading ? `Icon fetch: loading ${missingIconIds.length}` : `Icon cache: ${Object.keys(iconMap).length}`}
        </span>
      </section>

      <section className="playersPanel">
        {model.players.map((p) => (
          <label key={p} className="check">
            <input
              type="checkbox"
              checked={Boolean(enabledPlayers[p])}
              onChange={(e) => setEnabledPlayers((prev) => ({ ...prev, [p]: e.target.checked }))}
            />
            {p}
          </label>
        ))}
      </section>

      <section className="tableWrap">
        <table>
          <colgroup>
            {columnKeys.map((key) => (
              <col key={key} style={{ width: `${colWidths[key] ?? (key === 'time' ? 96 : 320)}px` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="stickyCol">
                <div className="thInner">
                    <span>Time</span>
                  <span
                    className="colResizer"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleResizeStart('time', e.clientX);
                    }}
                  />
                </div>
              </th>
              <th>
                <div className="thInner">
                  <span>Boss ({model.bossName})</span>
                  <span
                    className="colResizer bossResizer"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleResizeStart('boss', e.clientX);
                    }}
                  />
                </div>
              </th>
              {visiblePlayers.map((p) => (
                <th key={p}>
                  <div className="thInner">
                    <span>{p}</span>
                    <span
                      className="colResizer"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleResizeStart(p, e.clientX);
                      }}
                    />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayedRows.map((row) => (
              <tr key={row.second}>
                <td className="stickyCol timeCol">{formatTimelineTime(row.second)}</td>
                <td>
                  <AbilityCell list={row.boss} iconMap={iconMap} />
                </td>
                {visiblePlayers.map((p) => (
                  <td key={`${row.second}-${p}`}>
                    <AbilityCell list={row.players[p] ?? []} iconMap={iconMap} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
