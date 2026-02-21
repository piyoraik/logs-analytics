import { Fight, SelectedFightMeta } from '../fflogs/types';

export interface PickFightOptions {
  strategy: string;
  onlyKill: boolean;
  difficulty?: number;
  reportCode: string;
  debugFightID?: number;
}

function duration(fight: Fight): number {
  return fight.endTime - fight.startTime;
}

function withDifficultyPriority(fights: Fight[], difficulty?: number): Fight[] {
  if (difficulty == null) {
    return fights;
  }

  const preferred = fights.filter((f) => f.difficulty === difficulty);
  return preferred.length > 0 ? preferred : fights;
}

function parseByBoss(strategy: string): number | null {
  if (!strategy.startsWith('byBoss:')) {
    return null;
  }
  const value = Number(strategy.replace('byBoss:', ''));
  return Number.isFinite(value) ? value : null;
}

function toSelectedFight(reportCode: string, fight: Fight, reason: string): SelectedFightMeta {
  return {
    reportCode,
    fightID: fight.id,
    encounterID: fight.encounterID,
    name: fight.name,
    startTime: fight.startTime,
    endTime: fight.endTime,
    durationMs: duration(fight),
    difficulty: fight.difficulty,
    kill: fight.kill,
    boss: fight.boss,
    reason
  };
}

export function pickFight(fights: Fight[], options: PickFightOptions): SelectedFightMeta {
  if (fights.length === 0) {
    throw new Error('No fights in report.');
  }

  if (options.debugFightID != null) {
    const direct = fights.find((f) => f.id === options.debugFightID);
    if (!direct) {
      throw new Error(`--fight-id ${options.debugFightID} not found in report fights.`);
    }
    return toSelectedFight(options.reportCode, direct, 'debug override (--fight-id)');
  }

  let candidates = [...fights];
  const byBoss = parseByBoss(options.strategy);

  if (options.onlyKill) {
    const kills = candidates.filter((f) => f.kill);
    if (kills.length > 0) {
      candidates = kills;
    }
  }

  if (byBoss != null) {
    const bossFiltered = candidates.filter((f) => f.boss === byBoss || f.encounterID === byBoss);
    if (bossFiltered.length === 0) {
      throw new Error(`No fights matched strategy byBoss:${byBoss}.`);
    }
    candidates = bossFiltered;
  }

  candidates = withDifficultyPriority(candidates, options.difficulty);

  if (options.strategy === 'lastKill') {
    const kills = candidates.filter((f) => f.kill).sort((a, b) => a.startTime - b.startTime);
    if (kills.length === 0) {
      throw new Error('No kill fights available for strategy=lastKill.');
    }
    return toSelectedFight(options.reportCode, kills[kills.length - 1], 'strategy=lastKill');
  }

  if (options.strategy === 'firstKill') {
    const kills = candidates.filter((f) => f.kill).sort((a, b) => a.startTime - b.startTime);
    if (kills.length === 0) {
      throw new Error('No kill fights available for strategy=firstKill.');
    }
    return toSelectedFight(options.reportCode, kills[0], 'strategy=firstKill');
  }

  if (options.strategy === 'longest') {
    const longest = [...candidates].sort((a, b) => duration(b) - duration(a))[0];
    return toSelectedFight(options.reportCode, longest, 'strategy=longest');
  }

  if (options.strategy === 'best' || byBoss != null) {
    const ranked = [...candidates].sort((a, b) => {
      const killScore = Number(b.kill) - Number(a.kill);
      if (killScore !== 0) {
        return killScore;
      }
      const diffScore = Number((b.difficulty ?? 0) - (a.difficulty ?? 0));
      if (diffScore !== 0) {
        return diffScore;
      }
      const durScore = duration(b) - duration(a);
      if (durScore !== 0) {
        return durScore;
      }
      return b.startTime - a.startTime;
    });
    return toSelectedFight(options.reportCode, ranked[0], `strategy=${options.strategy}`);
  }

  throw new Error(`Unsupported strategy: ${options.strategy}`);
}
