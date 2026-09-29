import { describe, expect, it } from 'vitest';
import { QUEUE_MAX, VIEWERS_MAX } from '../constants';
import {
  ITEM_SEQ_MAX,
  WATCH_PARTY_STATE_VERSION,
  clampPosition,
  createWatchPartyInitialState,
  normalizeWatchPartyState,
  type WatchPartyState,
} from '../state';

const T0 = 1_700_000_000_000;

function valid(): WatchPartyState {
  return {
    version: WATCH_PARTY_STATE_VERSION,
    hostId: 'host',
    hostSince: T0,
    controlMode: 'everyone',
    current: { id: 'v1', videoId: 'aaaaaaaaaaa', startSec: 5, addedBy: 'host', addedAt: T0 },
    playback: { status: 'playing', positionSec: 12.5, updatedAt: T0 + 100 },
    queue: [{ id: 'v2', videoId: 'bbbbbbbbbbb', startSec: 0, addedBy: 'ana', addedAt: T0 + 1 }],
    viewers: [
      { userId: 'host', status: 'ready', joinedAt: T0, lastSeenAt: T0 + 5 },
      { userId: 'ana', status: 'buffering', joinedAt: T0 + 1, lastSeenAt: T0 + 6 },
    ],
    nextItemSeq: 3,
    stampedAt: T0 + 100,
  };
}

describe('createWatchPartyInitialState', () => {
  it('starts with the creator hosting and watching, nothing on screen', () => {
    expect(createWatchPartyInitialState({ hostId: 'host', now: T0 })).toEqual({
      version: 1,
      hostId: 'host',
      hostSince: T0,
      controlMode: 'host',
      current: null,
      playback: { status: 'paused', positionSec: 0, updatedAt: T0 },
      queue: [],
      viewers: [{ userId: 'host', status: 'idle', joinedAt: T0, lastSeenAt: T0 }],
      nextItemSeq: 1,
      stampedAt: T0,
    });
  });

  it('can start without a host', () => {
    const state = createWatchPartyInitialState({ hostId: null, now: T0 });
    expect(state.hostId).toBeNull();
    expect(state.viewers).toEqual([]);
  });
});

describe('normalizeWatchPartyState (migrateState)', () => {
  it('keeps a valid state as it is', () => {
    expect(normalizeWatchPartyState(valid())).toEqual(valid());
  });

  it('is idempotent', () => {
    const messy = { ...valid(), queue: [...valid().queue, { junk: true }], hostId: 42 };
    const once = normalizeWatchPartyState(messy);
    expect(normalizeWatchPartyState(once)).toEqual(once);
  });

  it.each([[null], [undefined], ['a string'], [42], [[]]])('turns %j into a fresh, clock-free party', (raw) => {
    expect(normalizeWatchPartyState(raw)).toEqual(createWatchPartyInitialState({ hostId: null, now: 0 }));
  });

  it('drops malformed items and viewers, keeps the good ones', () => {
    const raw = {
      ...valid(),
      current: { id: 'v1', videoId: 'not-an-id', addedBy: 'host' },
      queue: [
        { id: 'v2', videoId: 'bbbbbbbbbbb', addedBy: 'ana', addedAt: T0 },
        { id: 'v2', videoId: 'ccccccccccc', addedBy: 'ana', addedAt: T0 }, // duplicate id
        { id: 'x9', videoId: 'ccccccccccc', addedBy: 'ana' }, // bad id
        { id: 'v5', videoId: 'ccccccccccc' }, // no author
        'junk',
      ],
      viewers: [{ userId: 'host', status: 'weird' }, { userId: '' }, { userId: 'host' }, null],
    };
    const state = normalizeWatchPartyState(raw);
    expect(state.current).toBeNull();
    expect(state.queue.map((i) => i.id)).toEqual(['v2']);
    expect(state.viewers).toEqual([{ userId: 'host', status: 'idle', joinedAt: 0, lastSeenAt: 0 }]);
    // Nothing on screen cannot be playing.
    expect(state.playback.status).toBe('paused');
  });

  it('bounds positions and the queue and viewer lists', () => {
    const raw = {
      ...valid(),
      playback: { status: 'playing', positionSec: 1e9, updatedAt: -5 },
      queue: Array.from({ length: QUEUE_MAX + 10 }, (_, i) => ({
        id: `v${i + 2}`,
        videoId: `q${String(i).padStart(10, '0')}`,
        addedBy: 'ana',
        addedAt: T0,
      })),
      viewers: Array.from({ length: VIEWERS_MAX + 10 }, (_, i) => ({ userId: `u${i}`, status: 'ready' })),
    };
    const state = normalizeWatchPartyState(raw);
    expect(state.playback.positionSec).toBe(clampPosition(1e9));
    expect(state.playback.updatedAt).toBe(0);
    expect(state.queue).toHaveLength(QUEUE_MAX);
    // One slot over the join limit is kept for a moderator who took over a full party.
    expect(state.viewers).toHaveLength(VIEWERS_MAX + 1);
  });

  it('repairs an item counter that would reuse an id', () => {
    expect(normalizeWatchPartyState({ ...valid(), nextItemSeq: 1 }).nextItemSeq).toBe(3);
    expect(normalizeWatchPartyState({ ...valid(), nextItemSeq: 'x' }).nextItemSeq).toBe(3);
    expect(normalizeWatchPartyState({ ...valid(), nextItemSeq: ITEM_SEQ_MAX + 5 }).nextItemSeq).toBe(3);
    expect(normalizeWatchPartyState({ ...valid(), nextItemSeq: 40 }).nextItemSeq).toBe(40);
  });

  it('upgrades the M16 stub shape, resuming paused where it was', () => {
    const stub = {
      videoId: 'aaaaaaaaaaa',
      isPlaying: true,
      positionSeconds: 42,
      hostId: 'host',
      participants: ['host', 'ana', 7],
    };
    const state = normalizeWatchPartyState(stub);
    expect(state.version).toBe(1);
    expect(state.hostId).toBe('host');
    expect(state.current).toMatchObject({ id: 'v1', videoId: 'aaaaaaaaaaa', addedBy: 'host' });
    expect(state.playback).toEqual({ status: 'paused', positionSec: 42, updatedAt: 0 });
    expect(state.viewers.map((v) => v.userId)).toEqual(['host', 'ana']);
    expect(state.nextItemSeq).toBe(2);
  });
});

describe('clampPosition', () => {
  it('keeps positions inside [0, 12 h], to the millisecond', () => {
    expect(clampPosition(12.34567)).toBe(12.346);
    expect(clampPosition(-3)).toBe(0);
    expect(clampPosition(Number.NaN)).toBe(0);
    expect(clampPosition('5')).toBe(0);
    expect(clampPosition(1e12)).toBe(43_200);
  });
});
