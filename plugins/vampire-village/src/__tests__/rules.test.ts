import { describe, expect, it } from 'vitest';
import {
  DAWN_SECONDS,
  ROLE_REVEAL_SECONDS,
  VERDICT_SECONDS,
  majorityNeeded,
  rolesForPlayerCount,
  teamOf,
  vampireCountFor,
} from '../rules';
import type { VillageRole } from '../state';

const count = (roles: VillageRole[], role: VillageRole) => roles.filter((r) => r === role).length;

describe('rolesForPlayerCount (spec §8, MVP roles only)', () => {
  it.each([
    [5, 1],
    [6, 1],
    [7, 1],
    [8, 2],
    [9, 2],
    [10, 3],
    [11, 3],
    [12, 3],
  ])('%i players → %i vampires, one role each', (n, vampires) => {
    const roles = rolesForPlayerCount(n);
    expect(roles).toHaveLength(n);
    expect(count(roles, 'vampire')).toBe(vampires);
    expect(vampireCountFor(n)).toBe(vampires);
  });

  it('builds the 5-player base: vampire, seer, doctor, survivor and a villager', () => {
    expect(rolesForPlayerCount(5)).toEqual(['vampire', 'seer', 'doctor', 'survivor', 'villager']);
  });

  it('adds the hunter at 6 and the jester at 7, in that order', () => {
    expect(rolesForPlayerCount(6)).toEqual(['vampire', 'seer', 'doctor', 'survivor', 'hunter', 'villager']);
    expect(rolesForPlayerCount(7)).toEqual([
      'vampire',
      'seer',
      'doctor',
      'survivor',
      'hunter',
      'jester',
      'villager',
    ]);
  });

  it('never has more than one of any special role — extra seats are villagers', () => {
    for (let n = 5; n <= 12; n += 1) {
      const roles = rolesForPlayerCount(n);
      for (const special of ['seer', 'doctor', 'survivor', 'hunter', 'jester'] as const) {
        expect(count(roles, special), `${special} at ${n}`).toBeLessThanOrEqual(1);
      }
    }
    expect(count(rolesForPlayerCount(12), 'villager')).toBe(4);
  });

  it('keeps the village team ahead of the vampires at every size', () => {
    for (let n = 5; n <= 12; n += 1) {
      const roles = rolesForPlayerCount(n);
      const village = roles.filter((r) => teamOf(r) === 'village').length;
      expect(village, `at ${n}`).toBeGreaterThan(count(roles, 'vampire'));
    }
  });

  it('refuses sizes outside 5–12', () => {
    expect(rolesForPlayerCount(4)).toEqual([]);
    expect(rolesForPlayerCount(13)).toEqual([]);
  });
});

describe('teamOf', () => {
  it('sorts every role into its team', () => {
    expect(teamOf('vampire')).toBe('vampires');
    for (const role of ['villager', 'seer', 'doctor', 'hunter'] as const) expect(teamOf(role)).toBe('village');
    expect(teamOf('survivor')).toBe('neutral');
    expect(teamOf('jester')).toBe('neutral');
  });
});

describe('majorityNeeded', () => {
  it('is more than half of the living', () => {
    expect(majorityNeeded(1)).toBe(1);
    expect(majorityNeeded(2)).toBe(2);
    expect(majorityNeeded(3)).toBe(2);
    expect(majorityNeeded(4)).toBe(3);
    expect(majorityNeeded(5)).toBe(3);
    expect(majorityNeeded(6)).toBe(4);
    expect(majorityNeeded(12)).toBe(7);
  });
});

describe('fixed phase lengths (spec §9)', () => {
  it('uses the spec defaults for the short phases', () => {
    expect(ROLE_REVEAL_SECONDS).toBe(10);
    expect(DAWN_SECONDS).toBe(5);
    expect(VERDICT_SECONDS).toBe(5);
  });
});
