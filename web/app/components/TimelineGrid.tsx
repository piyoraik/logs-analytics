'use client';

import { useEffect, useMemo, useState } from 'react';
import { AbilityUse, GridRow, ViewModel } from '../../lib/types';

type DisplayMode = 'text' | 'icon' | 'both';

interface Props {
  model: ViewModel;
}

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');

function apiUrl(path: string): string {
  if (!API_BASE_URL) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL is not set.');
  }
  return `${API_BASE_URL}${path}`;
}

function containsKeyword(list: AbilityUse[], keyword: string): boolean {
  if (!keyword) {
    return true;
  }
  const k = keyword.toLowerCase();
  return list.some((x) => x.ability.toLowerCase().includes(k) || String(x.abilityId).includes(k));
}

function rowHasAnyContent(row: GridRow, visiblePlayers: string[]): boolean {
  if (row.boss.length > 0) {
    return true;
  }
  return visiblePlayers.some((p) => (row.players[p] ?? []).length > 0);
}

async function fetchIcons(ids: number[], lang: string): Promise<Record<string, string>> {
  if (ids.length === 0) {
    return {};
  }

  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 120) {
    chunks.push(ids.slice(i, i + 120));
  }

  const merged: Record<string, string> = {};
  for (const chunk of chunks) {
    const q = encodeURIComponent(chunk.join(','));
    const res = await fetch(apiUrl(`/ability-icons?ids=${q}&lang=${encodeURIComponent(lang)}`));
    if (!res.ok) {
      continue;
    }
    const json = (await res.json()) as { icons?: Record<string, string> };
    Object.assign(merged, json.icons ?? {});
  }

  return merged;
}

function AbilityCell({
  list,
  keyword,
  display,
  iconMap
}: {
  list: AbilityUse[];
  keyword: string;
  display: DisplayMode;
  iconMap: Record<string, string>;
}) {
  if (list.length === 0) {
    return <span className="dash">-</span>;
  }

  const k = keyword.toLowerCase();
  return (
    <div className="abilityList">
      {list.map((x, i) => {
        const matched = !k || x.ability.toLowerCase().includes(k) || String(x.abilityId).includes(k);
        const icon = iconMap[String(x.abilityId)];

        return (
          <span key={`${x.abilityId}-${i}`} className={`abilityItem ${matched ? 'hit' : ''}`}>
            {(display === 'icon' || display === 'both') && icon ? (
              <img className="abilityIcon" src={icon} alt={x.ability} title={`${x.ability} [${x.abilityId}]`} />
            ) : null}
            {display === 'icon' ? null : <span>{`${x.ability} [${x.abilityId}]`}</span>}
          </span>
        );
      })}
    </div>
  );
}

export default function TimelineGrid({ model }: Props) {
  const duration = Math.ceil(model.selectedFight.durationMs / 1000);

  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(Math.min(180, duration));
  const [keyword, setKeyword] = useState('');
  const [showBossOnly, setShowBossOnly] = useState(false);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('text');
  const [enabledPlayers, setEnabledPlayers] = useState<Record<string, boolean>>(
    Object.fromEntries(model.players.map((p) => [p, true]))
  );
  const [iconMap, setIconMap] = useState<Record<string, string>>({});
  const [iconLoading, setIconLoading] = useState(false);

  const visiblePlayers = useMemo(
    () => model.players.filter((p) => enabledPlayers[p]),
    [model.players, enabledPlayers]
  );

  const filteredRows = useMemo(() => {
    return model.rows
      .filter((row) => row.second >= startSec && row.second <= endSec)
      .filter((row) => {
        if (keyword && !containsKeyword(row.boss, keyword)) {
          const hitPlayer = visiblePlayers.some((p) => containsKeyword(row.players[p] ?? [], keyword));
          if (!hitPlayer) {
            return false;
          }
        }
        if (showBossOnly) {
          return row.boss.length > 0;
        }
        return rowHasAnyContent(row, visiblePlayers);
      });
  }, [model.rows, startSec, endSec, keyword, showBossOnly, visiblePlayers]);

  const missingIconIds = useMemo(() => {
    if (displayMode === 'text') {
      return [];
    }
    const ids = new Set<number>();
    for (const row of filteredRows) {
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
  }, [displayMode, filteredRows, visiblePlayers, iconMap]);

  useEffect(() => {
    if (missingIconIds.length === 0) {
      return;
    }

    let mounted = true;
    setIconLoading(true);
    fetchIcons(missingIconIds, 'ja')
      .then((icons) => {
        if (!mounted) {
          return;
        }
        setIconMap((prev) => ({ ...prev, ...icons }));
      })
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
      <section className="controls">
        <label>
          Start(s)
          <input type="number" min={0} max={duration} value={startSec} onChange={(e) => setStartSec(Number(e.target.value))} />
        </label>
        <label>
          End(s)
          <input type="number" min={0} max={duration} value={endSec} onChange={(e) => setEndSec(Number(e.target.value))} />
        </label>
        <label className="searchBox">
          Search
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="ability名 or ID" />
        </label>
        <label>
          Display
          <select value={displayMode} onChange={(e) => setDisplayMode(e.target.value as DisplayMode)}>
            <option value="text">Text</option>
            <option value="icon">Icon</option>
            <option value="both">Both</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={showBossOnly} onChange={(e) => setShowBossOnly(e.target.checked)} />
          Boss-only rows
        </label>
        <span className="status">
          {displayMode === 'text'
            ? 'Icon fetch: off'
            : iconLoading
              ? `Icon fetch: loading ${missingIconIds.length}`
              : `Icon cache: ${Object.keys(iconMap).length}`}
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
          <thead>
            <tr>
              <th className="stickyCol">Time(s)</th>
              <th>Boss ({model.bossName})</th>
              {showBossOnly
                ? null
                : visiblePlayers.map((p) => (
                    <th key={p}>{p}</th>
                  ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.second}>
                <td className="stickyCol timeCol">{row.second.toFixed(2)}</td>
                <td>
                  <AbilityCell list={row.boss} keyword={keyword} display={displayMode} iconMap={iconMap} />
                </td>
                {showBossOnly
                  ? null
                  : visiblePlayers.map((p) => (
                      <td key={`${row.second}-${p}`}>
                        <AbilityCell
                          list={row.players[p] ?? []}
                          keyword={keyword}
                          display={displayMode}
                          iconMap={iconMap}
                        />
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
