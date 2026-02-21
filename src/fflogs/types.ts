export type ActorType = 'Player' | 'NPC' | 'Pet' | string;

export interface Fight {
  id: number;
  encounterID: number;
  name: string;
  kill: boolean;
  startTime: number;
  endTime: number;
  boss?: number;
  difficulty?: number;
}

export interface Actor {
  id: number;
  gameID: number;
  name: string;
  type: ActorType;
  subType?: string;
  petOwner?: number;
}

export interface AbilityDef {
  gameID: number;
  name: string;
}

export interface AbilityRef {
  gameID?: number;
  guid?: number;
  name?: string;
}

export interface CastEvent {
  timestamp: number;
  type: string;
  sourceID?: number;
  targetID?: number;
  abilityGameID?: number;
  ability?: AbilityRef;
}

export interface EventsPage {
  data: CastEvent[];
  nextPageTimestamp: number | null;
}

export interface GraphQLErrorItem {
  message: string;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLErrorItem[];
}

export interface ActorMap {
  byId: Map<number, Actor>;
  abilityByGameId: Map<number, string>;
}

export interface ReportFightsResult {
  reportCode: string;
  fights: Fight[];
}

export interface SelectedFightMeta {
  reportCode: string;
  fightID: number;
  encounterID: number;
  name: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  difficulty?: number;
  kill: boolean;
  boss?: number;
  reason: string;
}

export interface RankingEntry {
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

export interface RankingsResult {
  encounterID: number;
  metric: string;
  difficulty?: number;
  pageSize?: number;
  rankIndex: number;
  filters: Record<string, string | number | undefined>;
  rankings: RankingEntry[];
}

export interface EncounterCandidate {
  id: number;
  name: string;
  zoneId?: number;
  zoneName?: string;
}

export interface EncounterGroup {
  zoneId: number;
  zoneName: string;
  encounters: Array<{ id: number; name: string }>;
}

export interface TimelineEntry {
  t: number;
  source: string;
  ability: string;
  abilityId: number;
}

export interface PlayerCastEntry {
  t: number;
  source: string;
  sourceId: number;
  ability: string;
  abilityId: number;
}

export interface AbilitySummary {
  ability: string;
  abilityId: number;
  count: number;
  firstUse: number;
  lastUse: number;
  avgInterval: number | null;
  cpm: number;
}

export interface PlayerSummary {
  player: string;
  playerId: number;
  totalCasts: number;
  abilities: AbilitySummary[];
}
