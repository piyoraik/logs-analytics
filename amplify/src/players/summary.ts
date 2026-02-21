import { AbilitySummary, PlayerCastEntry, PlayerSummary } from '../fflogs/types';

function averageIntervalSeconds(entries: PlayerCastEntry[]): number | null {
  if (entries.length < 2) {
    return null;
  }
  let total = 0;
  for (let i = 1; i < entries.length; i += 1) {
    total += entries[i].t - entries[i - 1].t;
  }
  return total / (entries.length - 1);
}

function summarizeAbility(entries: PlayerCastEntry[], durationMinutes: number): AbilitySummary {
  const sorted = [...entries].sort((a, b) => a.t - b.t);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const count = sorted.length;

  return {
    ability: first.ability,
    abilityId: first.abilityId,
    count,
    firstUse: first.t,
    lastUse: last.t,
    avgInterval: averageIntervalSeconds(sorted),
    cpm: durationMinutes > 0 ? count / durationMinutes : 0
  };
}

export function buildPlayerSummary(
  castsByPlayer: Record<string, PlayerCastEntry[]>,
  fightDurationMs: number
): PlayerSummary[] {
  const durationMinutes = fightDurationMs / 1000 / 60;
  const result: PlayerSummary[] = [];

  for (const [key, entries] of Object.entries(castsByPlayer)) {
    const [playerName, playerIdText] = key.split('#');
    const playerId = Number(playerIdText);
    const byAbility = new Map<number, PlayerCastEntry[]>();

    for (const entry of entries) {
      const list = byAbility.get(entry.abilityId) ?? [];
      list.push(entry);
      byAbility.set(entry.abilityId, list);
    }

    const abilities = [...byAbility.values()]
      .map((abilityEntries) => summarizeAbility(abilityEntries, durationMinutes))
      .sort((a, b) => b.count - a.count || a.ability.localeCompare(b.ability));

    result.push({
      player: playerName,
      playerId,
      totalCasts: entries.length,
      abilities
    });
  }

  return result.sort((a, b) => b.totalCasts - a.totalCasts || a.player.localeCompare(b.player));
}
