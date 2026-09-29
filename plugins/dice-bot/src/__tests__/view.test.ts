import { describe, expect, it } from 'vitest';
import { DICE_DEFAULT_SIDES, DICE_DIE_SIZES, diceStatRows, elapsedSince, isDiceRoll, recentRolls } from '../view';

describe('dice panel — the stats table', () => {
  it('derives each player’s average from what the reducer tracks', () => {
    const [row] = diceStatRows({ kaya: { rolls: 4, sum: 14, best: 6 } });
    expect(row).toEqual({ userId: 'kaya', rolls: 4, sum: 14, best: 6, average: 3.5 });
  });

  it('puts the best single roll first, then the higher total, then more rolls', () => {
    const rows = diceStatRows({
      low: { rolls: 9, sum: 30, best: 5 },
      tiedMore: { rolls: 3, sum: 12, best: 6 },
      tiedLess: { rolls: 2, sum: 9, best: 6 },
      top: { rolls: 1, sum: 20, best: 20 },
    });
    expect(rows.map((row) => row.userId)).toEqual(['top', 'tiedMore', 'tiedLess', 'low']);
  });

  it('keeps equal rows in a stable order', () => {
    const rows = diceStatRows({ b: { rolls: 1, sum: 4, best: 4 }, a: { rolls: 1, sum: 4, best: 4 } });
    expect(rows.map((row) => row.userId)).toEqual(['a', 'b']);
  });

  it('survives a missing or malformed stats blob', () => {
    expect(diceStatRows(undefined)).toEqual([]);
    expect(diceStatRows(null)).toEqual([]);
    const [row] = diceStatRows({ x: { rolls: Number.NaN, sum: 3, best: 3 } });
    expect(row!.average).toBe(0);
  });
});

describe('dice panel — the roll feed', () => {
  const roll = (value: number) => ({ playerId: 'p', sides: 6, value, at: '2026-09-28T10:00:00.000Z' });

  it('lists the newest rolls and counts the ones it leaves out', () => {
    const history = Array.from({ length: 11 }, (_, i) => roll(i + 1));
    const { visible, hidden } = recentRolls(history, 8);
    expect(visible.map((r) => r.value)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(hidden).toBe(3);
  });

  it('drops malformed entries instead of drawing them', () => {
    expect(recentRolls([roll(3), { value: 'x' }, null]).visible).toHaveLength(1);
    expect(recentRolls(undefined)).toEqual({ visible: [], hidden: 0 });
    expect(isDiceRoll(roll(2))).toBe(true);
    expect(isDiceRoll({ ...roll(2), at: 5 })).toBe(false);
  });
});

describe('dice panel — how long ago', () => {
  const now = Date.parse('2026-09-28T12:00:00.000Z');
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it('reads the largest whole unit', () => {
    expect(elapsedSince(ago(2), now)).toEqual({ unit: 'now' });
    expect(elapsedSince(ago(42), now)).toEqual({ unit: 'seconds', count: 42 });
    expect(elapsedSince(ago(125), now)).toEqual({ unit: 'minutes', count: 2 });
    expect(elapsedSince(ago(3 * 3600 + 5), now)).toEqual({ unit: 'hours', count: 3 });
    expect(elapsedSince(ago(49 * 3600), now)).toEqual({ unit: 'days', count: 2 });
  });

  it('never goes negative for a clock slightly ahead, and ignores a bad timestamp', () => {
    expect(elapsedSince(ago(-30), now)).toEqual({ unit: 'now' });
    expect(elapsedSince('not a date', now)).toBeNull();
  });
});

describe('dice panel — the picker', () => {
  it('starts on a die it offers', () => {
    expect(DICE_DIE_SIZES).toContain(DICE_DEFAULT_SIDES);
  });
});
