import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisconnectReason } from 'livekit-client';
import {
  LOBBY_VIEW_KEY,
  VOICE_LOCK_NAME,
  VOICE_RECONNECT_WINDOW_MS,
  VOICE_RESUME_FRESH_MS,
  VOICE_RESUME_KEY,
  VoiceReconnectPolicy,
  clearLobbyView,
  clearVoiceResume,
  holdVoiceLock,
  isVoiceLockHeldElsewhere,
  isVoiceResumeFresh,
  planVoiceResume,
  readLobbyView,
  readMicrophonePermission,
  readNavigationType,
  readVoiceResume,
  touchVoiceResume,
  tryAcquireVoiceLock,
  voiceReconnectDelay,
  voiceResumeClearsOnDisconnect,
  voiceResumeClearsOnRefusal,
  writeLobbyView,
  writeVoiceResume,
  type VoiceResumeRecord,
} from '../voice-resume';

/** An in-memory sessionStorage. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

/** Storage that throws on every access, like a private window or blocked site data. */
const throwingStorage = {
  getItem: () => {
    throw new DOMException('blocked', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('full', 'QuotaExceededError');
  },
  removeItem: () => {
    throw new DOMException('blocked', 'SecurityError');
  },
};

const RECORD = { serverId: 'srv-1', channelId: 'ch-1', channelName: 'Lounge' };
const NOW = 1_800_000_000_000;

describe('the resume record', () => {
  it('is written, read back, refreshed by the heartbeat and cleared', () => {
    const storage = memoryStorage();
    expect(writeVoiceResume(RECORD, NOW, storage)).toBe(true);
    expect(readVoiceResume(storage)).toEqual({ ...RECORD, at: NOW });
    touchVoiceResume(NOW + 5_000, storage);
    expect(readVoiceResume(storage)?.at).toBe(NOW + 5_000);
    clearVoiceResume(storage);
    expect(readVoiceResume(storage)).toBeNull();
    expect(storage.map.has(VOICE_RESUME_KEY)).toBe(false);
  });

  it('a heartbeat after a clear does not bring the record back', () => {
    const storage = memoryStorage();
    writeVoiceResume(RECORD, NOW, storage);
    clearVoiceResume(storage);
    touchVoiceResume(NOW + 5_000, storage);
    expect(readVoiceResume(storage)).toBeNull();
  });

  it('reads a malformed record as none', () => {
    const storage = memoryStorage();
    for (const raw of ['{', '"text"', '[]', JSON.stringify({ channelId: 'c', at: 1 }), JSON.stringify({ ...RECORD, at: 'soon' }), JSON.stringify({ ...RECORD, serverId: '', at: 1 })]) {
      storage.map.set(VOICE_RESUME_KEY, raw);
      expect(readVoiceResume(storage)).toBeNull();
    }
    // A missing name is not fatal: the lobby names the channel itself.
    storage.map.set(VOICE_RESUME_KEY, JSON.stringify({ serverId: 's', channelId: 'c', at: 5 }));
    expect(readVoiceResume(storage)).toEqual({ serverId: 's', channelId: 'c', channelName: '', at: 5 });
  });

  it('survives storage that throws (private mode, blocked site data) and no storage at all', () => {
    expect(readVoiceResume(throwingStorage)).toBeNull();
    expect(writeVoiceResume(RECORD, NOW, throwingStorage)).toBe(false);
    expect(() => touchVoiceResume(NOW, throwingStorage)).not.toThrow();
    expect(() => clearVoiceResume(throwingStorage)).not.toThrow();
    expect(readVoiceResume(null)).toBeNull();
    expect(writeVoiceResume(RECORD, NOW, null)).toBe(false);
    expect(() => clearVoiceResume(null)).not.toThrow();
    // Outside a browser (this suite runs in node) the default storage is none.
    expect(readVoiceResume()).toBeNull();
    expect(writeVoiceResume(RECORD)).toBe(false);
  });

  it('is fresh for two minutes after it was last refreshed', () => {
    expect(isVoiceResumeFresh({ at: NOW }, NOW)).toBe(true);
    expect(isVoiceResumeFresh({ at: NOW }, NOW + VOICE_RESUME_FRESH_MS - 1)).toBe(true);
    expect(isVoiceResumeFresh({ at: NOW }, NOW + VOICE_RESUME_FRESH_MS)).toBe(false);
    expect(isVoiceResumeFresh({ at: NOW }, NOW + 10 * 60_000)).toBe(false);
    // The clock moved back a little: still the same visit.
    expect(isVoiceResumeFresh({ at: NOW + 30_000 }, NOW)).toBe(true);
  });
});

describe('which endings clear the record', () => {
  it('clears when coming back would undo the ending', () => {
    // Another tab took over: coming back would kick it out, forever in turn.
    expect(voiceResumeClearsOnDisconnect(DisconnectReason.DUPLICATE_IDENTITY)).toBe(true);
    // A moderator removed them: an automatic return must not undo it.
    expect(voiceResumeClearsOnDisconnect(DisconnectReason.PARTICIPANT_REMOVED)).toBe(true);
    expect(voiceResumeClearsOnDisconnect(DisconnectReason.ROOM_DELETED)).toBe(true);
  });

  it('keeps it for a drop, a restart, and the page leaving (a reload)', () => {
    // LiveKit gave up reconnecting: no reason at all.
    expect(voiceResumeClearsOnDisconnect(undefined)).toBe(false);
    expect(voiceResumeClearsOnDisconnect(DisconnectReason.CLIENT_INITIATED)).toBe(false);
    expect(voiceResumeClearsOnDisconnect(DisconnectReason.SERVER_SHUTDOWN)).toBe(false);
    expect(voiceResumeClearsOnDisconnect(DisconnectReason.UNKNOWN_REASON)).toBe(false);
    expect(voiceResumeClearsOnDisconnect(DisconnectReason.SIGNAL_CLOSE)).toBe(false);
    expect(voiceResumeClearsOnDisconnect(DisconnectReason.JOIN_FAILURE)).toBe(false);
    expect(voiceResumeClearsOnDisconnect(DisconnectReason.STATE_MISMATCH)).toBe(false);
  });

  it('clears when the server refuses voice, keeps it when trying later can work', () => {
    expect(voiceResumeClearsOnRefusal(403, { code: 'voice_blocked', retryAfter: 600 })).toBe(true);
    expect(voiceResumeClearsOnRefusal(401, {})).toBe(true);
    expect(voiceResumeClearsOnRefusal(403, { error: 'Forbidden' })).toBe(true);
    expect(voiceResumeClearsOnRefusal(404, null)).toBe(true);
    expect(voiceResumeClearsOnRefusal(429, { error: 'slow down' })).toBe(false);
    expect(voiceResumeClearsOnRefusal(500, {})).toBe(false);
    expect(voiceResumeClearsOnRefusal(503, { code: 'voice_unavailable' })).toBe(false);
  });
});

describe('planVoiceResume', () => {
  const record: VoiceResumeRecord = { ...RECORD, at: NOW - 10_000 };
  const base = {
    record,
    serverId: 'srv-1',
    now: NOW,
    channels: [{ id: 'ch-1', name: 'Game room' }],
    lockHeldElsewhere: false,
    navigationType: 'reload',
    microphone: 'granted' as const,
  };

  it('goes back on its own after a reload with the microphone already allowed', () => {
    expect(planVoiceResume(base)).toEqual({ kind: 'offer', channelId: 'ch-1', channelName: 'Game room', auto: true });
  });

  it('offers one click otherwise', () => {
    for (const microphone of ['prompt', 'denied', 'unknown'] as const) {
      expect(planVoiceResume({ ...base, microphone })).toMatchObject({ kind: 'offer', auto: false });
    }
    for (const navigationType of ['navigate', 'back_forward', null]) {
      expect(planVoiceResume({ ...base, navigationType })).toMatchObject({ kind: 'offer', auto: false });
    }
  });

  it('names the channel from the record when the list is not known', () => {
    expect(planVoiceResume({ ...base, channels: null })).toMatchObject({ kind: 'offer', channelName: 'Lounge' });
  });

  it('leaves alone a record of another community, and does nothing without one', () => {
    expect(planVoiceResume({ ...base, serverId: 'srv-2' })).toEqual({ kind: 'none' });
    expect(planVoiceResume({ ...base, record: null })).toEqual({ kind: 'none' });
  });

  it('clears a stale record, a channel that is gone, and a copy while another tab is in voice', () => {
    expect(planVoiceResume({ ...base, now: NOW + VOICE_RESUME_FRESH_MS })).toEqual({ kind: 'clear' });
    expect(planVoiceResume({ ...base, channels: [{ id: 'ch-2', name: 'Other' }] })).toEqual({ kind: 'clear' });
    expect(planVoiceResume({ ...base, lockHeldElsewhere: true })).toEqual({ kind: 'clear' });
  });
});

/**
 * A small Web Locks stand-in: one exclusive lock, `ifAvailable`, a queue
 * and abort signals — what the voice lock uses.
 */
class FakeLocks {
  held = false;
  private queue: Array<() => void> = [];

  request = vi.fn(
    async (
      name: string,
      options: { ifAvailable?: boolean; signal?: AbortSignal },
      callback: (lock: { name: string } | null) => unknown
    ): Promise<unknown> => {
      if (options.ifAvailable && this.held) return callback(null);
      if (this.held) {
        await new Promise<void>((resolve, reject) => {
          const grant = () => resolve();
          this.queue.push(grant);
          options.signal?.addEventListener('abort', () => {
            this.queue = this.queue.filter((entry) => entry !== grant);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      this.held = true;
      try {
        return await callback({ name });
      } finally {
        this.held = false;
        this.queue.shift()?.();
      }
    }
  );

  query = async () => ({ held: this.held ? [{ name: VOICE_LOCK_NAME, mode: 'exclusive' as const }] : [] });
}

const asLocks = (fake: FakeLocks) => fake as unknown as LockManager;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const noWait = { sleep: async () => {} };

describe('the cross-tab voice lock', () => {
  it('lets exactly one tab take it', async () => {
    const locks = new FakeLocks();
    const first = await tryAcquireVoiceLock(asLocks(locks));
    expect(first).not.toBeNull();
    expect(await isVoiceLockHeldElsewhere(asLocks(locks), noWait)).toBe(true);
    // A duplicated tab with the same record does not get it.
    expect(await tryAcquireVoiceLock(asLocks(locks))).toBeNull();
    first!.release();
    await settle();
    expect(await isVoiceLockHeldElsewhere(asLocks(locks), noWait)).toBe(false);
    expect(await tryAcquireVoiceLock(asLocks(locks))).not.toBeNull();
  });

  it('does not count the reloaded page’s own lock, still on record for a moment', async () => {
    let looks = 0;
    const query = vi.fn(async () => {
      looks += 1;
      return { held: looks <= 2 ? [{ name: VOICE_LOCK_NAME }] : [] };
    });
    const sleep = vi.fn(async () => {});
    const locks = { request: vi.fn(), query } as unknown as LockManager;
    expect(await isVoiceLockHeldElsewhere(locks, { sleep })).toBe(false);
    expect(query).toHaveBeenCalledTimes(3);

    // Held for longer than the grace: another tab is in voice.
    const always = { request: vi.fn(), query: async () => ({ held: [{ name: VOICE_LOCK_NAME }] }) } as unknown as LockManager;
    sleep.mockClear();
    expect(await isVoiceLockHeldElsewhere(always, { sleep, graceMs: 1_000 })).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(4);
    // Some other lock of the origin is not ours.
    const other = { request: vi.fn(), query: async () => ({ held: [{ name: 'something-else' }] }) } as unknown as LockManager;
    expect(await isVoiceLockHeldElsewhere(other, noWait)).toBe(false);
  });

  it('holds it while in voice; a second tab waits in line, or leaves the line', async () => {
    const locks = new FakeLocks();
    const inVoice = holdVoiceLock(asLocks(locks));
    await settle();
    expect(locks.held).toBe(true);
    expect(await tryAcquireVoiceLock(asLocks(locks))).toBeNull();

    const waiting = holdVoiceLock(asLocks(locks));
    const leaving = holdVoiceLock(asLocks(locks));
    leaving.release();
    inVoice.release();
    await settle();
    // The tab still in line got it.
    expect(locks.held).toBe(true);
    waiting.release();
    await settle();
    expect(locks.held).toBe(false);
    // Releasing twice is harmless.
    expect(() => waiting.release()).not.toThrow();
  });

  it('falls back to no lock without the Locks API, or when it throws', async () => {
    const free = await tryAcquireVoiceLock(null);
    expect(free).not.toBeNull();
    expect(() => free!.release()).not.toThrow();
    expect(await isVoiceLockHeldElsewhere(null)).toBe(false);
    expect(() => holdVoiceLock(null).release()).not.toThrow();

    const broken = {
      request: () => {
        throw new DOMException('insecure', 'SecurityError');
      },
      query: () => Promise.reject(new Error('nope')),
    } as unknown as LockManager;
    expect(await tryAcquireVoiceLock(broken)).not.toBeNull();
    expect(await isVoiceLockHeldElsewhere(broken, noWait)).toBe(false);
    expect(() => holdVoiceLock(broken).release()).not.toThrow();

    const rejecting = { request: () => Promise.reject(new Error('nope')) } as unknown as LockManager;
    expect(await tryAcquireVoiceLock(rejecting)).not.toBeNull();
    // No query(): nobody can be seen holding it.
    expect(await isVoiceLockHeldElsewhere(rejecting)).toBe(false);
  });

  it('defaults to no lock outside a browser', async () => {
    expect(await tryAcquireVoiceLock()).not.toBeNull();
    expect(await isVoiceLockHeldElsewhere()).toBe(false);
  });
});

describe('the reconnect policy', () => {
  const noJitter = () => 0;

  it('starts with livekit-client’s own delays, then tries every 7 s', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map((retryCount) => voiceReconnectDelay({ retryCount, elapsedMs: 0 }, noJitter));
    expect(delays).toEqual([0, 300, 1_200, 2_700, 4_800, 7_000, 7_000]);
    // Up to a second of jitter from the third try on, none before.
    expect(voiceReconnectDelay({ retryCount: 1, elapsedMs: 0 }, () => 0.99)).toBe(300);
    expect(voiceReconnectDelay({ retryCount: 2, elapsedMs: 0 }, () => 0.5)).toBe(1_700);
  });

  it('gives up after about two minutes, not after ten tries', () => {
    let elapsed = 0;
    let retryCount = 0;
    for (;;) {
      const delay = voiceReconnectDelay({ retryCount, elapsedMs: elapsed }, () => 0.5);
      if (delay === null) break;
      elapsed += delay;
      retryCount += 1;
    }
    expect(retryCount).toBeGreaterThan(10);
    expect(elapsed).toBeLessThanOrEqual(VOICE_RECONNECT_WINDOW_MS + 1_000);
    expect(elapsed).toBeGreaterThan(VOICE_RECONNECT_WINDOW_MS - 10_000);
  });

  it('is a livekit ReconnectPolicy', () => {
    const policy = new VoiceReconnectPolicy(noJitter);
    expect(policy.nextRetryDelayInMs({ retryCount: 5, elapsedMs: 30_000 })).toBe(7_000);
    expect(policy.nextRetryDelayInMs({ retryCount: 30, elapsedMs: VOICE_RECONNECT_WINDOW_MS })).toBeNull();
  });
});

describe('what the browser says about this load', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the navigation type, or null', () => {
    vi.stubGlobal('performance', { getEntriesByType: () => [{ type: 'reload' }] });
    expect(readNavigationType()).toBe('reload');
    vi.stubGlobal('performance', { getEntriesByType: () => [] });
    expect(readNavigationType()).toBeNull();
    vi.stubGlobal('performance', {
      getEntriesByType: () => {
        throw new Error('no timeline');
      },
    });
    expect(readNavigationType()).toBeNull();
  });

  it('reads the microphone permission, or unknown where the browser will not say', async () => {
    vi.stubGlobal('navigator', { permissions: { query: async () => ({ state: 'granted' }) } });
    expect(await readMicrophonePermission()).toBe('granted');
    // Firefox and older Safari throw for "microphone".
    vi.stubGlobal('navigator', {
      permissions: {
        query: async () => {
          throw new TypeError('microphone is not a valid permission name');
        },
      },
    });
    expect(await readMicrophonePermission()).toBe('unknown');
    vi.stubGlobal('navigator', {});
    expect(await readMicrophonePermission()).toBe('unknown');
  });
});

describe('the view to reopen', () => {
  it('remembers the activities view of a channel and forgets it', () => {
    const storage = memoryStorage();
    writeLobbyView({ mode: 'activity', channelId: 'ch-1' }, storage);
    expect(JSON.parse(storage.map.get(LOBBY_VIEW_KEY)!)).toEqual({ mode: 'activity', channelId: 'ch-1' });
    expect(readLobbyView(storage)).toEqual({ mode: 'activity', channelId: 'ch-1' });
    clearLobbyView(storage);
    expect(readLobbyView(storage)).toBeNull();
  });

  it('ignores anything else, and storage that throws', () => {
    const storage = memoryStorage();
    storage.map.set(LOBBY_VIEW_KEY, JSON.stringify({ mode: 'chat', channelId: 'ch-1' }));
    expect(readLobbyView(storage)).toBeNull();
    storage.map.set(LOBBY_VIEW_KEY, '{oops');
    expect(readLobbyView(storage)).toBeNull();
    expect(readLobbyView(throwingStorage)).toBeNull();
    expect(() => writeLobbyView({ mode: 'activity', channelId: 'x' }, throwingStorage)).not.toThrow();
    expect(() => clearLobbyView(throwingStorage)).not.toThrow();
  });
});
