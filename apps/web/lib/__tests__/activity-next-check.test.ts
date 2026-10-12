import { describe, expect, it } from 'vitest';
import { HOST_CHECK_MARGIN_MS } from '../activity-host-view';
import { nextActivityCheck, parseTimersDueAt, serverClockOffset } from '../activity-next-check';

/**
 * One re-read at the earliest due moment, for the host hand-over and the
 * plugin's timers alike (lib/activity-next-check.ts).
 */
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('nextActivityCheck', () => {
  it('nothing due: no host away and no timers', () => {
    expect(nextActivityCheck({}, NOW)).toBeNull();
    expect(nextActivityCheck({ host: null, timersDueAt: [] }, NOW)).toBeNull();
  });

  it('picks the earliest of the plugin timers and the host’s due times', () => {
    const host = { userId: 'u', inVoice: false, awaySince: at(-10_000), transferAt: at(50_000), abandonAt: at(170_000), abandoned: false };
    expect(nextActivityCheck({ host, timersDueAt: [at(20_000), at(90_000)] }, NOW)).toEqual({
      at: NOW + 20_000,
      delay: 20_000 + HOST_CHECK_MARGIN_MS,
    });
    expect(nextActivityCheck({ host, timersDueAt: [at(70_000)] }, NOW)).toEqual({ at: NOW + 50_000, delay: 50_000 + HOST_CHECK_MARGIN_MS });
  });

  it('a timer already due gets one immediate re-read, but not again for the same time', () => {
    expect(nextActivityCheck({ timersDueAt: [at(-1_000), at(30_000)] }, NOW)).toEqual({ at: NOW - 1_000, delay: HOST_CHECK_MARGIN_MS });
    expect(nextActivityCheck({ timersDueAt: [at(-1_000), at(30_000)] }, NOW, NOW - 1_000)).toEqual({
      at: NOW + 30_000,
      delay: 30_000 + HOST_CHECK_MARGIN_MS,
    });
  });

  it('ignores what is not a time', () => {
    expect(parseTimersDueAt(['soon', 3, null, at(5_000)])).toEqual([at(5_000)]);
    expect(parseTimersDueAt('2026-10-12')).toEqual([]);
    expect(nextActivityCheck({ timersDueAt: ['soon'] as string[] }, NOW)).toBeNull();
  });
});

describe('serverClockOffset', () => {
  it('is the server clock minus this device’s, 0 without one', () => {
    expect(serverClockOffset(at(30_000), NOW)).toBe(30_000);
    expect(serverClockOffset(at(-2_000), NOW)).toBe(-2_000);
    expect(serverClockOffset(undefined, NOW)).toBe(0);
    expect(serverClockOffset('garbage', NOW)).toBe(0);
  });
});
