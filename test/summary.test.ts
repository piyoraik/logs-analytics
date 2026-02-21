import { describe, expect, it } from 'vitest';
import { buildPlayerSummary } from '../amplify/src/players/summary';

describe('buildPlayerSummary', () => {
  it('aggregates count, avg interval, and cpm', () => {
    const casts = {
      'Alice#1': [
        { t: 0, source: 'Alice', sourceId: 1, ability: 'Fire', abilityId: 10 },
        { t: 30, source: 'Alice', sourceId: 1, ability: 'Fire', abilityId: 10 },
        { t: 60, source: 'Alice', sourceId: 1, ability: 'Ice', abilityId: 11 }
      ]
    };

    const summary = buildPlayerSummary(casts, 120_000);
    expect(summary[0].totalCasts).toBe(3);
    expect(summary[0].abilities[0].ability).toBe('Fire');
    expect(summary[0].abilities[0].count).toBe(2);
    expect(summary[0].abilities[0].avgInterval).toBe(30);
    expect(summary[0].abilities[0].cpm).toBe(1);
  });
});
