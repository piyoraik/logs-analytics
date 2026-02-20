import { Actor, ActorMap, CastEvent, PlayerCastEntry } from '../fflogs/types';

function isPlayer(actor: Actor | undefined): boolean {
  return actor?.type === 'Player';
}

function resolveAbility(
  event: CastEvent,
  actors: ActorMap,
  extraAbilityById?: Map<number, string>
): { abilityName: string; abilityId: number } {
  const abilityId = event.abilityGameID ?? event.ability?.gameID ?? event.ability?.guid ?? -1;
  // If XIVAPI map is provided, treat it as authoritative and do not fallback to FFLogs names.
  if (extraAbilityById) {
    return {
      abilityName: extraAbilityById.get(abilityId) ?? `Ability#${abilityId}`,
      abilityId
    };
  }
  const abilityName =
    event.ability?.name ?? actors.abilityByGameId.get(abilityId) ?? `Ability#${abilityId}`;
  return { abilityName, abilityId };
}

export function buildPlayerCasts(
  events: CastEvent[],
  actors: ActorMap,
  fightStartTime: number,
  extraAbilityById?: Map<number, string>
): Record<string, PlayerCastEntry[]> {
  const grouped = new Map<number, PlayerCastEntry[]>();

  for (const event of events) {
    if (event.sourceID == null) {
      continue;
    }

    const actor = actors.byId.get(event.sourceID);
    if (!isPlayer(actor)) {
      continue;
    }

    const { abilityName, abilityId } = resolveAbility(event, actors, extraAbilityById);
    const entry: PlayerCastEntry = {
      t: (event.timestamp - fightStartTime) / 1000,
      source: actor?.name ?? `Actor#${event.sourceID}`,
      sourceId: event.sourceID,
      ability: abilityName,
      abilityId
    };

    const list = grouped.get(event.sourceID) ?? [];
    list.push(entry);
    grouped.set(event.sourceID, list);
  }

  const result: Record<string, PlayerCastEntry[]> = {};
  for (const entries of grouped.values()) {
    entries.sort((a, b) => a.t - b.t);
    const key = `${entries[0].source}#${entries[0].sourceId}`;
    result[key] = entries;
  }

  return result;
}
