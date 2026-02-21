import { describe, expect, it } from 'vitest';
import { pickFight } from '../amplify/src/select/pickFight';
import { Fight } from '../amplify/src/fflogs/types';

const fights: Fight[] = [
  {
    id: 1,
    encounterID: 100,
    name: 'Boss A',
    kill: false,
    startTime: 0,
    endTime: 120000,
    difficulty: 100,
    boss: 100
  },
  {
    id: 2,
    encounterID: 100,
    name: 'Boss A',
    kill: true,
    startTime: 130000,
    endTime: 300000,
    difficulty: 100,
    boss: 100
  },
  {
    id: 3,
    encounterID: 101,
    name: 'Boss B',
    kill: true,
    startTime: 310000,
    endTime: 520000,
    difficulty: 101,
    boss: 101
  }
];

describe('pickFight', () => {
  it('picks best fight by default with kill+difficulty priority', () => {
    const selected = pickFight(fights, {
      strategy: 'best',
      onlyKill: true,
      reportCode: 'ABC123'
    });

    expect(selected.fightID).toBe(3);
  });

  it('picks last kill', () => {
    const selected = pickFight(fights, {
      strategy: 'lastKill',
      onlyKill: true,
      reportCode: 'ABC123'
    });

    expect(selected.fightID).toBe(3);
  });
});
