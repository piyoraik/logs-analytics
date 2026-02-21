import { AbilityUse, GridRow, PlayerCastEntry, TimelineEntry, ViewModel, SelectedFight } from './types';

function toUse(ability: string, abilityId: number): AbilityUse {
  return { ability, abilityId };
}

export function buildViewModel(
  selectedFight: SelectedFight,
  bossTimeline: TimelineEntry[],
  playersCasts: Record<string, PlayerCastEntry[]>
): ViewModel {
  const players = Object.keys(playersCasts);
  const durationSec = Math.ceil(selectedFight.durationMs / 1000);

  const rows: GridRow[] = Array.from({ length: durationSec + 1 }, (_, second) => ({
    second,
    boss: [],
    players: {}
  }));

  for (const event of bossTimeline) {
    const sec = Math.max(0, Math.floor(event.t));
    if (sec >= rows.length) {
      continue;
    }
    rows[sec].boss.push(toUse(event.ability, event.abilityId));
  }

  for (const [player, casts] of Object.entries(playersCasts)) {
    for (const cast of casts) {
      const sec = Math.max(0, Math.floor(cast.t));
      if (sec >= rows.length) {
        continue;
      }
      const list = rows[sec].players[player] ?? [];
      list.push(toUse(cast.ability, cast.abilityId));
      rows[sec].players[player] = list;
    }
  }

  return {
    selectedFight,
    bossName: bossTimeline[0]?.source ?? 'Boss',
    players,
    rows
  };
}
