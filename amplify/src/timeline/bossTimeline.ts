import { Actor, ActorMap, CastEvent, TimelineEntry } from '../fflogs/types';

function isPlayer(actor: Actor | undefined): boolean {
  return actor?.type === 'Player';
}

function isPet(actor: Actor | undefined): boolean {
  if (!actor) {
    return false;
  }
  return actor.type === 'Pet' || actor.petOwner != null;
}

function isEnemyCandidate(actor: Actor | undefined): boolean {
  if (!actor) {
    return true;
  }
  if (isPlayer(actor) || isPet(actor)) {
    return false;
  }
  return true;
}

function isCastLike(event: CastEvent): boolean {
  const t = String(event.type || '').toLowerCase();
  return t === 'cast' || t === 'begincast';
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

/**
 * PoC rule: pick the non-player actor with the highest cast count as boss candidate.
 * This should be replaced by stricter encounter/boss metadata matching in production.
 */
export function inferBossActorId(events: CastEvent[], actors: ActorMap): number | null {
  const counts = new Map<number, number>();

  for (const event of events) {
    if (event.sourceID == null) {
      continue;
    }
    const actor = actors.byId.get(event.sourceID);
    if (!isEnemyCandidate(actor)) {
      continue;
    }
    counts.set(event.sourceID, (counts.get(event.sourceID) ?? 0) + 1);
  }

  let best: { id: number; count: number } | null = null;
  for (const [id, count] of counts.entries()) {
    if (!best || count > best.count) {
      best = { id, count };
    }
  }

  return best?.id ?? null;
}

export function buildBossTimeline(
  events: CastEvent[],
  actors: ActorMap,
  fightStartTime: number,
  extraAbilityById?: Map<number, string>
): TimelineEntry[] {
  const bossActorId = inferBossActorId(events, actors);
  if (bossActorId == null) {
    return [];
  }

  const bossName = actors.byId.get(bossActorId)?.name ?? `Actor#${bossActorId}`;

  const bossEvents = events.filter((event) => event.sourceID === bossActorId);
  const castLike = bossEvents.filter((event) => isCastLike(event));
  const picked = castLike.length > 0 ? castLike : bossEvents;

  return picked
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((event) => {
      const { abilityName, abilityId } = resolveAbility(event, actors, extraAbilityById);
      return {
        t: (event.timestamp - fightStartTime) / 1000,
        source: bossName,
        ability: abilityName,
        abilityId
      };
    });
}
