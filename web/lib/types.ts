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

export interface Fight {
  id: number;
  encounterID: number;
  name: string;
  kill: boolean;
  startTime: number;
  endTime: number;
  difficulty?: number;
}

export interface SelectedFight {
  reportCode: string;
  fightID: number;
  encounterID: number;
  name: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  difficulty?: number;
  kill: boolean;
  reason: string;
}

export interface AbilityUse {
  ability: string;
  abilityId: number;
}

export interface GridRow {
  second: number;
  boss: AbilityUse[];
  players: Record<string, AbilityUse[]>;
}

export interface ViewModel {
  selectedFight: SelectedFight;
  bossName: string;
  players: string[];
  rows: GridRow[];
}
