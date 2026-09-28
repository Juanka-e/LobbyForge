import { describe, expect, it } from 'vitest';
import {
  DRIFT_TOLERANCE_SEC,
  HOST_HEARTBEAT_MS,
  STATUS_DEBOUNCE_MS,
  STATUS_MIN_INTERVAL_MS,
  VIEWER_AWAY_MS,
  VIEWER_HEARTBEAT_MS,
} from '../constants';
import { PLAYER_STATE } from '../player-protocol';
import { createWatchPartyInitialState, type WatchPartyState, type WatchPartyViewer } from '../state';
import {
  CLOCK_SAMPLES_KEPT,
  CLOCK_SAMPLE_MAX_AGE_MS,
  addClockSample,
  clockSample,
  desiredViewerStatus,
  estimateClockOffset,
  expectedPositionSec,
  formatTime,
  planCorrection,
  roomSummary,
  statusReportDecision,
  type ClockSample,
  type ReportInput,
  type ViewerStatusInput,
} from '../sync';

const T0 = 1_700_000_000_000;

describe('expectedPositionSec — where the video should be', () => {
  const playing = { status: 'playing' as const, positionSec: 30, updatedAt: T0 };

  it('advances with server time while playing', () => {
    expect(expectedPositionSec(playing, T0)).toBe(30);
    expect(expectedPositionSec(playing, T0 + 1_500)).toBe(31.5);
    expect(expectedPositionSec(playing, T0 + 60_000)).toBe(90);
  });

  it('holds still while paused', () => {
    expect(expectedPositionSec({ ...playing, status: 'paused' }, T0 + 60_000)).toBe(30);
  });

  it('stops at the end of the video when its length is known', () => {
    expect(expectedPositionSec(playing, T0 + 600_000, 200)).toBe(200);
    expect(expectedPositionSec(playing, T0 + 600_000, null)).toBe(630);
    expect(expectedPositionSec(playing, T0 + 600_000, 0)).toBe(630);
  });

  it('never goes backwards when "now" is before the record (a clock behind)', () => {
    expect(expectedPositionSec(playing, T0 - 10_000)).toBe(30);
  });
});

describe('clock offset from server stamps', () => {
  // The server clock runs 7 s ahead of this machine: offset = +7000 ms.
  const TRUE_OFFSET = 7_000;
  const localNow = T0;
  /** A change the server stamped at server time S arrives `latency` ms later (local clock). */
  const arrive = (serverStamp: number, latency: number) => clockSample(serverStamp, serverStamp - TRUE_OFFSET + latency);

  it('starts at 0 with no samples (trust the local clock until a change arrives)', () => {
    expect(estimateClockOffset([])).toBe(0);
  });

  it('never overestimates: each sample is the offset minus that delivery’s latency', () => {
    const sample = arrive(T0 + 1_000, 120)!;
    expect(sample.offsetMs).toBe(TRUE_OFFSET - 120);
  });

  it('takes the best (quickest) delivery seen', () => {
    let samples: ClockSample[] = [];
    for (const [stamp, latency] of [
      [T0, 900],
      [T0 + 1_000, 40],
      [T0 + 2_000, 300],
      [T0 + 3_000, 2_500], // a delivery via the 5 s polling fallback
    ] as const) {
      samples = addClockSample(samples, arrive(stamp, latency), localNow + 3_000);
    }
    expect(estimateClockOffset(samples)).toBe(TRUE_OFFSET - 40);
  });

  it('works just as well for a clock that is BEHIND the server… or ahead of it', () => {
    const ahead = clockSample(T0, T0 + 30_000 + 25)!; // local clock 30 s ahead
    expect(estimateClockOffset([ahead])).toBe(-30_025);
  });

  it('forgets old samples, so a corrected clock is noticed', () => {
    const old: ClockSample = { offsetMs: 60_000, at: localNow };
    const fresh: ClockSample = { offsetMs: 2_000, at: localNow + CLOCK_SAMPLE_MAX_AGE_MS + 1 };
    const kept = addClockSample([old], fresh, localNow + CLOCK_SAMPLE_MAX_AGE_MS + 1);
    expect(kept).toEqual([fresh]);
    expect(estimateClockOffset(kept)).toBe(2_000);
  });

  it(`keeps at most ${CLOCK_SAMPLES_KEPT} samples`, () => {
    let samples: ClockSample[] = [];
    for (let i = 0; i < CLOCK_SAMPLES_KEPT + 5; i += 1) {
      samples = addClockSample(samples, { offsetMs: i, at: localNow + i }, localNow + i);
    }
    expect(samples).toHaveLength(CLOCK_SAMPLES_KEPT);
    expect(samples[0]!.offsetMs).toBe(5);
  });

  it('refuses stamps that cannot be samples', () => {
    expect(clockSample(0, localNow)).toBeNull();
    expect(clockSample(Number.NaN, localNow)).toBeNull();
    expect(clockSample(T0 + 3 * 24 * 3_600_000, T0)).toBeNull(); // "3 days apart" is corruption
    expect(addClockSample([], null, localNow)).toEqual([]);
  });
});

describe('planCorrection — matching a player to the room', () => {
  const base = { expected: 100, durationSec: 300 };

  describe('room playing', () => {
    it('leaves a player within the tolerance alone', () => {
      for (const drift of [0, DRIFT_TOLERANCE_SEC - 0.01, -(DRIFT_TOLERANCE_SEC - 0.01)]) {
        expect(
          planCorrection({ ...base, roomStatus: 'playing', playerState: PLAYER_STATE.PLAYING, localTime: 100 + drift })
        ).toEqual({ kind: 'none' });
      }
    });

    it(`seeks a playing or buffering player that drifted more than ${DRIFT_TOLERANCE_SEC} s`, () => {
      expect(planCorrection({ ...base, roomStatus: 'playing', playerState: PLAYER_STATE.PLAYING, localTime: 97 })).toEqual({
        kind: 'seek',
        to: 100,
      });
      expect(planCorrection({ ...base, roomStatus: 'playing', playerState: PLAYER_STATE.BUFFERING, localTime: 104 })).toEqual({
        kind: 'seek',
        to: 100,
      });
    });

    it('starts a paused, cued or unstarted player — seeking only if it is elsewhere', () => {
      expect(planCorrection({ ...base, roomStatus: 'playing', playerState: PLAYER_STATE.PAUSED, localTime: 99.5 })).toEqual({
        kind: 'play',
        seekTo: null,
      });
      expect(planCorrection({ ...base, roomStatus: 'playing', playerState: PLAYER_STATE.CUED, localTime: 0 })).toEqual({
        kind: 'play',
        seekTo: 100,
      });
      expect(planCorrection({ ...base, roomStatus: 'playing', playerState: PLAYER_STATE.UNSTARTED, localTime: null })).toEqual({
        kind: 'play',
        seekTo: 100,
      });
    });

    it('restarts a player that ended early; waits at the real end', () => {
      expect(planCorrection({ ...base, roomStatus: 'playing', playerState: PLAYER_STATE.ENDED, localTime: 300 })).toEqual({
        kind: 'play',
        seekTo: 100,
      });
      expect(
        planCorrection({ roomStatus: 'playing', expected: 299.5, durationSec: 300, playerState: PLAYER_STATE.ENDED, localTime: 300 })
      ).toEqual({ kind: 'none' });
      expect(planCorrection({ ...base, durationSec: null, roomStatus: 'playing', playerState: PLAYER_STATE.ENDED, localTime: 5 })).toEqual({
        kind: 'none',
      });
    });
  });

  describe('room paused', () => {
    it('pauses a playing player, seeking back if it wandered off', () => {
      expect(planCorrection({ ...base, roomStatus: 'paused', playerState: PLAYER_STATE.PLAYING, localTime: 100.4 })).toEqual({
        kind: 'pause',
        seekTo: null,
      });
      expect(planCorrection({ ...base, roomStatus: 'paused', playerState: PLAYER_STATE.BUFFERING, localTime: 140 })).toEqual({
        kind: 'pause',
        seekTo: 100,
      });
    });

    it('moves a paused player to the room’s frame (a paused player stays paused when seeked)', () => {
      expect(planCorrection({ ...base, roomStatus: 'paused', playerState: PLAYER_STATE.PAUSED, localTime: 50 })).toEqual({
        kind: 'seek',
        to: 100,
      });
      expect(planCorrection({ ...base, roomStatus: 'paused', playerState: PLAYER_STATE.PAUSED, localTime: 101 })).toEqual({
        kind: 'none',
      });
    });

    it('never seeks a cued, unstarted or ended player — YouTube would start it', () => {
      for (const playerState of [PLAYER_STATE.CUED, PLAYER_STATE.UNSTARTED, PLAYER_STATE.ENDED]) {
        expect(planCorrection({ ...base, roomStatus: 'paused', playerState, localTime: 0 })).toEqual({ kind: 'none' });
      }
    });
  });

  it('does nothing before the player reports a state', () => {
    expect(planCorrection({ ...base, roomStatus: 'playing', playerState: null, localTime: null })).toEqual({ kind: 'none' });
  });
});

describe('desiredViewerStatus', () => {
  const ready: ViewerStatusInput = {
    hasVideo: true,
    connected: true,
    engaged: true,
    blocked: false,
    hold: false,
    error: null,
    playerState: PLAYER_STATE.PLAYING,
    roomStatus: 'playing',
  };

  it('is ready when the player plays along', () => {
    expect(desiredViewerStatus(ready)).toBe('ready');
    expect(desiredViewerStatus({ ...ready, roomStatus: 'paused', playerState: PLAYER_STATE.PAUSED })).toBe('ready');
    expect(desiredViewerStatus({ ...ready, roomStatus: 'paused', playerState: PLAYER_STATE.CUED })).toBe('ready');
    expect(desiredViewerStatus({ ...ready, playerState: PLAYER_STATE.ENDED })).toBe('ready');
  });

  it('is buffering while loading or starting up', () => {
    expect(desiredViewerStatus({ ...ready, connected: false })).toBe('buffering');
    expect(desiredViewerStatus({ ...ready, playerState: null })).toBe('buffering');
    expect(desiredViewerStatus({ ...ready, playerState: PLAYER_STATE.BUFFERING })).toBe('buffering');
    expect(desiredViewerStatus({ ...ready, playerState: PLAYER_STATE.CUED })).toBe('buffering');
  });

  it('is idle when not playing along: not joined, blocked, paused on purpose, or an error', () => {
    expect(desiredViewerStatus({ ...ready, engaged: false })).toBe('idle');
    expect(desiredViewerStatus({ ...ready, blocked: true })).toBe('idle');
    expect(desiredViewerStatus({ ...ready, hold: true })).toBe('idle');
    expect(desiredViewerStatus({ ...ready, error: 150 })).toBe('idle');
  });

  it('has nothing to say without a video', () => {
    expect(desiredViewerStatus({ ...ready, hasVideo: false })).toBeNull();
  });
});

describe('statusReportDecision — few, meaningful reports', () => {
  const now = T0 + 100_000;
  const input = (overrides: Partial<ReportInput>): ReportInput => ({
    desired: 'ready',
    serverStatus: 'buffering',
    desiredSince: now - STATUS_DEBOUNCE_MS,
    lastSentAt: now - STATUS_MIN_INTERVAL_MS,
    now,
    isHost: false,
    canBeListed: true,
    ...overrides,
  });

  it('reports a change once it has held and the last report is far enough back', () => {
    expect(statusReportDecision(input({}))).toEqual({ send: true, status: 'ready' });
  });

  it('waits out a blip: a new status must hold for the debounce', () => {
    expect(statusReportDecision(input({ desiredSince: now - 500 }))).toEqual({
      send: false,
      retryAt: now - 500 + STATUS_DEBOUNCE_MS,
    });
  });

  it('never reports more often than the minimum interval', () => {
    expect(statusReportDecision(input({ lastSentAt: now - 1_000 }))).toEqual({
      send: false,
      retryAt: now - 1_000 + STATUS_MIN_INTERVAL_MS,
    });
  });

  it('says nothing when the room already shows the right status…', () => {
    expect(statusReportDecision(input({ serverStatus: 'ready', lastSentAt: now - 10_000 }))).toEqual({
      send: false,
      retryAt: now - 10_000 + VIEWER_HEARTBEAT_MS,
    });
  });

  it('…until a heartbeat is due: every few minutes for viewers, every minute for the host', () => {
    expect(statusReportDecision(input({ serverStatus: 'ready', lastSentAt: now - VIEWER_HEARTBEAT_MS }))).toEqual({
      send: true,
      status: 'ready',
    });
    expect(
      statusReportDecision(input({ serverStatus: 'ready', isHost: true, lastSentAt: now - HOST_HEARTBEAT_MS }))
    ).toEqual({ send: true, status: 'ready' });
  });

  it('keeps the heartbeat going with no video (desired null)', () => {
    expect(statusReportDecision(input({ desired: null, serverStatus: 'idle', lastSentAt: now - VIEWER_HEARTBEAT_MS }))).toEqual({
      send: true,
      status: 'idle',
    });
    expect(statusReportDecision(input({ desired: null, serverStatus: 'idle', lastSentAt: now - 1 })).send).toBe(false);
  });

  it('lists a viewer through a report when there is room, and never spams a full list', () => {
    expect(statusReportDecision(input({ serverStatus: undefined }))).toEqual({ send: true, status: 'ready' });
    expect(statusReportDecision(input({ serverStatus: undefined, canBeListed: false }))).toEqual({ send: false, retryAt: null });
    expect(statusReportDecision(input({ serverStatus: undefined, desired: null }))).toEqual({ send: false, retryAt: null });
  });

  it('spends at most a handful of actions per viewer per minute, however the player flaps', () => {
    // A player flapping between ready and buffering every second for ten minutes.
    let serverStatus: ReportInput['serverStatus'] = 'ready';
    let desired: ReportInput['desired'] = 'ready';
    let desiredSince = T0;
    let lastSentAt = T0;
    let changes = 0;
    let heartbeats = 0;
    for (let t = T0; t < T0 + 10 * 60_000; t += 1_000) {
      const next = Math.floor((t - T0) / 1_000) % 2 === 0 ? 'buffering' : 'ready';
      if (next !== desired) {
        desired = next;
        desiredSince = t;
      }
      const decision = statusReportDecision({ desired, serverStatus, desiredSince, lastSentAt, now: t, isHost: false, canBeListed: true });
      if (decision.send) {
        if (decision.status === serverStatus) heartbeats += 1;
        else changes += 1;
        lastSentAt = t;
        serverStatus = decision.status;
      }
    }
    // Flapping faster than the debounce is never reported as a change…
    expect(changes).toBe(0);
    // …and the viewer still says it is there: one heartbeat, five minutes in.
    expect(VIEWER_HEARTBEAT_MS).toBe(5 * 60_000);
    expect(heartbeats).toBe(1);
  });

  it('reports a real, lasting change within the debounce plus one interval', () => {
    // Ready for a minute, then genuinely stuck buffering.
    const stuckAt = T0 + 60_000;
    let serverStatus: ReportInput['serverStatus'] = 'ready';
    let lastSentAt = T0;
    let reportedAt: number | null = null;
    for (let t = T0; t < T0 + 120_000 && reportedAt === null; t += 1_000) {
      const desired = t < stuckAt ? 'ready' : 'buffering';
      const decision = statusReportDecision({
        desired,
        serverStatus,
        desiredSince: t < stuckAt ? T0 : stuckAt,
        lastSentAt,
        now: t,
        isHost: false,
        canBeListed: true,
      });
      if (decision.send) {
        lastSentAt = t;
        serverStatus = decision.status;
        if (decision.status === 'buffering') reportedAt = t;
      }
    }
    expect(reportedAt).toBe(stuckAt + STATUS_DEBOUNCE_MS + 500);
  });
});

describe('roomSummary — the header pill', () => {
  const viewer = (userId: string, status: WatchPartyViewer['status'], lastSeenAt = T0): WatchPartyViewer => ({
    userId,
    status,
    joinedAt: T0,
    lastSeenAt,
  });
  const room = (overrides: Partial<WatchPartyState>): WatchPartyState => ({
    ...createWatchPartyInitialState({ hostId: 'h', now: T0 }),
    current: { id: 'v1', videoId: 'aaaaaaaaaaa', startSec: 0, addedBy: 'h', addedAt: T0 },
    playback: { status: 'playing', positionSec: 0, updatedAt: T0 },
    ...overrides,
  });

  it('knows an empty and a paused room', () => {
    expect(roomSummary(createWatchPartyInitialState({ hostId: 'h', now: T0 }), T0)).toEqual({ kind: 'empty' });
    expect(roomSummary(room({ playback: { status: 'paused', positionSec: 0, updatedAt: T0 } }), T0)).toEqual({ kind: 'paused' });
  });

  it('is "all in sync" only when everyone present is ready', () => {
    expect(roomSummary(room({ viewers: [viewer('h', 'ready'), viewer('a', 'ready')] }), T0)).toEqual({ kind: 'synced' });
    expect(roomSummary(room({ viewers: [viewer('h', 'ready'), viewer('a', 'idle')] }), T0)).toEqual({ kind: 'playing' });
  });

  it('counts who is buffering', () => {
    expect(
      roomSummary(room({ viewers: [viewer('h', 'buffering'), viewer('a', 'buffering'), viewer('b', 'ready')] }), T0)
    ).toEqual({ kind: 'buffering', count: 2 });
  });

  it('ignores viewers who have gone away (a closed tab does not buffer forever)', () => {
    const now = T0 + VIEWER_AWAY_MS + 1;
    expect(roomSummary(room({ viewers: [viewer('h', 'ready', now), viewer('gone', 'buffering', T0)] }), now)).toEqual({
      kind: 'synced',
    });
  });
});

describe('formatTime', () => {
  it.each([
    [0, '0:00'],
    [7.9, '0:07'],
    [768, '12:48'],
    [3723, '1:02:03'],
    [-5, '0:00'],
  ])('%d → %s', (seconds, text) => {
    expect(formatTime(seconds)).toBe(text);
  });

  it('shows placeholders for an unknown length', () => {
    expect(formatTime(null)).toBe('--:--');
    expect(formatTime(Number.NaN)).toBe('--:--');
  });
});
