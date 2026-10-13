import { describe, expect, it } from 'vitest';
import { CHECK_BACKOFF_MAX_MS, HOST_CHECK_MARGIN_MS, checkBackoffMs } from '../activity-host-view';
import { activityDueTimes, nextActivityCheck, parseTimersDueAt, recordCheck, serverClockOffset } from '../activity-next-check';

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

  it('a timer already due gets one immediate re-read, then a back-off for the same time', () => {
    expect(nextActivityCheck({ timersDueAt: [at(-1_000), at(30_000)] }, NOW)).toEqual({ at: NOW - 1_000, delay: HOST_CHECK_MARGIN_MS });
    expect(nextActivityCheck({ timersDueAt: [at(-1_000), at(30_000)] }, NOW, new Map([[NOW - 1_000, 1]]))).toEqual({
      at: NOW - 1_000,
      delay: 2_000 + HOST_CHECK_MARGIN_MS,
    });
    // Backed off far enough, the next future timer comes first.
    expect(nextActivityCheck({ timersDueAt: [at(-1_000), at(30_000)] }, NOW, new Map([[NOW - 1_000, 6]]))).toEqual({
      at: NOW + 30_000,
      delay: 30_000 + HOST_CHECK_MARGIN_MS,
    });
  });

  it('several due times that stay pending never loop: re-reads back off to one a minute (security review)', () => {
    // Two timers already due that the server keeps reporting (it cannot
    // fire them yet). The old single "fired for" time alternated between
    // them and every open panel re-read every 1.5 s forever.
    const input = { timersDueAt: [at(-5_000), at(-2_000)] };
    const times = activityDueTimes(input);
    let clock = NOW;
    let history: ReturnType<typeof recordCheck> | null = null;
    const delays: number[] = [];
    while (clock < NOW + 30 * 60_000) {
      const next = nextActivityCheck(input, clock, history);
      expect(next).not.toBeNull();
      delays.push(next!.delay);
      clock += next!.delay;
      history = recordCheck(history, times, clock);
    }
    // One read covers both (a read fires everything due): they back off together.
    expect(delays.slice(0, 6)).toEqual([0, 2_000, 4_000, 8_000, 16_000, 32_000].map((d) => d + HOST_CHECK_MARGIN_MS));
    expect(Math.max(...delays)).toBe(CHECK_BACKOFF_MAX_MS + HOST_CHECK_MARGIN_MS);
    // Half an hour: a few dozen reads, not 1 200.
    expect(delays.length).toBeLessThan(40);
  });

  it('a new due time is re-read for at once even while older stuck ones back off', () => {
    const stuck = new Map([[NOW - 60_000, 7]]);
    expect(nextActivityCheck({ timersDueAt: [at(-60_000), at(-500)] }, NOW, stuck)).toEqual({
      at: NOW - 500,
      delay: HOST_CHECK_MARGIN_MS,
    });
  });

  it('recordCheck counts a re-read for every due time that had passed and forgets the ones no longer pending', () => {
    const first = recordCheck(null, [NOW - 1_000, NOW + 10_000], NOW);
    expect([...first]).toEqual([
      [NOW - 1_000, 1],
      [NOW + 10_000, 0],
    ]);
    const second = recordCheck(first, [NOW + 10_000], NOW + 20_000);
    expect([...second]).toEqual([[NOW + 10_000, 1]]);
    expect(checkBackoffMs(0)).toBe(0);
    expect(checkBackoffMs(1)).toBe(2_000);
    expect(checkBackoffMs(30)).toBe(CHECK_BACKOFF_MAX_MS);
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
