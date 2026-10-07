import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_MIN_MS,
  HOST_AWAY_MS,
  POSITION_MAX_SEC,
  QUEUE_MAX,
  QUEUE_MAX_PER_USER,
  VIEWER_AWAY_MS,
  VIEWERS_MAX,
} from '../constants';
import {
  LINK_ERROR,
  LINK_TOO_LONG_ERROR,
  WATCH_PARTY_ACTION_TYPES,
  canControlPlayback,
  isHostAway,
  positionAt,
  queueRefusal,
  validateWatchPartyAction,
  watchPartyHostChange,
  watchPartyReducer,
  type WatchPartyAction,
} from '../reducer';
import { createWatchPartyInitialState, type WatchPartyItem, type WatchPartyState } from '../state';
import { YOUTUBE_URL_MAX_LENGTH } from '../youtube';
import { watchPartyPlugin } from '../index';

const T0 = 1_700_000_000_000;
const HOST = 'host-1';
const ANA = 'ana-2';
const BO = 'bo-3';
const ID_A = 'aaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbb';
const ID_C = 'ccccccccccc';
const url = (id: string, extra = '') => `https://youtu.be/${id}${extra}`;

function act(state: WatchPartyState, action: WatchPartyAction, now = T0 + 1_000): WatchPartyState {
  return watchPartyReducer(state, action, now);
}

/** A party with HOST (creator), ANA and BO watching since T0. */
function party(overrides: Partial<WatchPartyState> = {}): WatchPartyState {
  let state = createWatchPartyInitialState({ hostId: HOST, now: T0 });
  state = act(state, { type: 'join', actorId: ANA }, T0);
  state = act(state, { type: 'join', actorId: BO }, T0);
  return { ...state, ...overrides };
}

function item(id: string, videoId: string, addedBy = HOST, startSec = 0): WatchPartyItem {
  return { id, videoId, startSec, addedBy, addedAt: T0 };
}

/** A party showing video A, with B and C queued (B by ANA, C by BO). */
function watching(status: 'playing' | 'paused' = 'paused', overrides: Partial<WatchPartyState> = {}): WatchPartyState {
  return party({
    current: item('v1', ID_A),
    queue: [item('v2', ID_B, ANA), item('v3', ID_C, BO)],
    nextItemSeq: 4,
    playback: { status, positionSec: 30, updatedAt: T0 },
    ...overrides,
  });
}

describe('validateWatchPartyAction', () => {
  it('lets every well-formed action through', () => {
    const good: WatchPartyAction[] = [
      { type: 'join', actorId: ANA },
      { type: 'leave', actorId: ANA },
      { type: 'report-status', actorId: ANA, status: 'buffering' },
      { type: 'set-video', actorId: HOST, url: url(ID_A) },
      { type: 'queue-add', actorId: ANA, url: `https://www.youtube.com/watch?v=${ID_B}` },
      { type: 'queue-remove', actorId: ANA, itemId: 'v2' },
      { type: 'queue-move', actorId: HOST, itemId: 'v2', toIndex: 0 },
      { type: 'queue-play', actorId: HOST, itemId: 'v2' },
      { type: 'skip', actorId: HOST },
      { type: 'video-ended', actorId: HOST, itemId: 'v1' },
      { type: 'video-ended', actorId: HOST, itemId: 'v1', positionSec: 212.5 },
      { type: 'play', actorId: HOST },
      { type: 'play', actorId: HOST, positionSec: 12 },
      { type: 'pause', actorId: HOST, positionSec: 0 },
      { type: 'seek', actorId: HOST, positionSec: POSITION_MAX_SEC },
      { type: 'set-control-mode', actorId: HOST, mode: 'everyone' },
      { type: 'transfer-host', actorId: HOST, toUserId: ANA },
      { type: 'claim-host', actorId: ANA },
      { type: 'take-host', actorId: ANA },
    ];
    for (const action of good) expect(validateWatchPartyAction(action), action.type).toBeNull();
    // …and there is one example of each type.
    expect(new Set(good.map((a) => a.type))).toEqual(new Set(WATCH_PARTY_ACTION_TYPES));
  });

  it.each([
    ['not an object', 'join', /object/],
    ['an array', [], /object/],
    ['null', null, /object/],
  ])('rejects %s', (_label, action, message) => {
    expect(validateWatchPartyAction(action)).toMatch(message);
  });

  it.each([
    [{ type: 'explode', actorId: ANA }, /Unknown action type/],
    [{ type: 42, actorId: ANA }, /Unknown action type/],
    [{ type: 'join' }, /actorId/],
    [{ type: 'join', actorId: '' }, /actorId/],
    [{ type: 'join', actorId: 'x'.repeat(200) }, /actorId/],
    [{ type: 'report-status', actorId: ANA, status: 'asleep' }, /status/],
    [{ type: 'set-video', actorId: HOST, url: 'https://vimeo.com/123' }, /Only YouTube/],
    [{ type: 'queue-add', actorId: ANA, url: 42 }, /Only YouTube/],
    [{ type: 'queue-add', actorId: ANA }, /Only YouTube/],
    [{ type: 'queue-remove', actorId: ANA, itemId: 'x1' }, /itemId/],
    [{ type: 'queue-play', actorId: HOST }, /itemId/],
    [{ type: 'queue-move', actorId: HOST, itemId: 'nope', toIndex: 0 }, /itemId/],
    [{ type: 'queue-move', actorId: HOST, itemId: 'v2', toIndex: 1.5 }, /toIndex/],
    [{ type: 'queue-move', actorId: HOST, itemId: 'v2', toIndex: -1 }, /toIndex/],
    [{ type: 'queue-move', actorId: HOST, itemId: 'v2', toIndex: QUEUE_MAX }, /toIndex/],
    [{ type: 'video-ended', actorId: HOST }, /itemId/],
    [{ type: 'video-ended', actorId: HOST, itemId: 'v1', positionSec: -1 }, /positionSec/],
    [{ type: 'play', actorId: HOST, positionSec: '12' }, /positionSec/],
    [{ type: 'pause', actorId: HOST, positionSec: Number.NaN }, /positionSec/],
    [{ type: 'seek', actorId: HOST }, /positionSec/],
    [{ type: 'seek', actorId: HOST, positionSec: POSITION_MAX_SEC + 1 }, /positionSec/],
    [{ type: 'seek', actorId: HOST, positionSec: Number.POSITIVE_INFINITY }, /positionSec/],
    [{ type: 'set-control-mode', actorId: HOST, mode: 'anarchy' }, /mode/],
    [{ type: 'transfer-host', actorId: HOST }, /toUserId/],
    [{ type: 'transfer-host', actorId: HOST, toUserId: '' }, /toUserId/],
  ])('rejects %j', (action, message) => {
    expect(validateWatchPartyAction(action)).toMatch(message);
  });

  it('explains which links work', () => {
    expect(validateWatchPartyAction({ type: 'queue-add', actorId: ANA, url: 'https://example.com' })).toBe(LINK_ERROR);
  });

  it('says a link is too long — not "not a YouTube link" — when it is over the limit', () => {
    const long = `https://youtu.be/${ID_A}?si=${'a'.repeat(YOUTUBE_URL_MAX_LENGTH)}`;
    expect(validateWatchPartyAction({ type: 'queue-add', actorId: ANA, url: long })).toBe(LINK_TOO_LONG_ERROR);
    expect(validateWatchPartyAction({ type: 'set-video', actorId: HOST, url: long })).toBe(LINK_TOO_LONG_ERROR);
    expect(LINK_TOO_LONG_ERROR).toContain(String(YOUTUBE_URL_MAX_LENGTH));
    // At the limit it is judged on what it is.
    const atLimit = `https://youtu.be/${ID_A}?si=`.padEnd(YOUTUBE_URL_MAX_LENGTH, 'a');
    expect(atLimit).toHaveLength(YOUTUBE_URL_MAX_LENGTH);
    expect(validateWatchPartyAction({ type: 'queue-add', actorId: ANA, url: atLimit })).toBeNull();
  });
});

describe('the reducer never trusts shape', () => {
  it('returns the same state for an invalid action', () => {
    const state = watching();
    expect(act(state, { type: 'seek', actorId: HOST, positionSec: -5 } as WatchPartyAction)).toBe(state);
    expect(act(state, { type: 'nope' } as unknown as WatchPartyAction)).toBe(state);
    expect(act(state, { type: 'join' } as unknown as WatchPartyAction)).toBe(state);
  });
});

describe('join and leave', () => {
  it('adds a viewer, stamped with the server time', () => {
    const state = createWatchPartyInitialState({ hostId: HOST, now: T0 });
    const next = act(state, { type: 'join', actorId: ANA }, T0 + 5);
    expect(next.viewers.map((v) => v.userId)).toEqual([HOST, ANA]);
    expect(next.viewers[1]).toEqual({ userId: ANA, status: 'idle', joinedAt: T0 + 5, lastSeenAt: T0 + 5 });
    expect(next.stampedAt).toBe(T0 + 5);
    expect(next.hostId).toBe(HOST);
  });

  it('ignores a repeated join inside the heartbeat window (same object back)', () => {
    const state = party();
    expect(act(state, { type: 'join', actorId: ANA }, T0 + HEARTBEAT_MIN_MS - 1)).toBe(state);
  });

  it('treats a later re-join as a heartbeat', () => {
    const state = party();
    const next = act(state, { type: 'join', actorId: ANA }, T0 + HEARTBEAT_MIN_MS);
    expect(next.viewers.find((v) => v.userId === ANA)?.lastSeenAt).toBe(T0 + HEARTBEAT_MIN_MS);
    expect(next.viewers).toHaveLength(3);
  });

  it('hands a hostless party to whoever joins', () => {
    const state = createWatchPartyInitialState({ hostId: null, now: T0 });
    const next = act(state, { type: 'join', actorId: ANA }, T0 + 7);
    expect(next.hostId).toBe(ANA);
    expect(next.hostSince).toBe(T0 + 7);
  });

  it('stops listing people when the list is full', () => {
    const viewers = Array.from({ length: VIEWERS_MAX }, (_, i) => ({
      userId: `u${i}`,
      status: 'idle' as const,
      joinedAt: T0,
      lastSeenAt: T0,
    }));
    const state = party({ viewers });
    expect(act(state, { type: 'join', actorId: 'late' })).toBe(state);
  });

  it('removes a viewer who leaves; the host stays', () => {
    const next = act(party(), { type: 'leave', actorId: ANA });
    expect(next.viewers.map((v) => v.userId)).toEqual([HOST, BO]);
    expect(next.hostId).toBe(HOST);
  });

  it('passes the host to the longest-present viewer who is still around', () => {
    const state = party();
    const next = act(state, { type: 'leave', actorId: HOST }, T0 + 60_000);
    expect(next.hostId).toBe(ANA);
    expect(next.hostSince).toBe(T0 + 60_000);
  });

  it('skips viewers who have gone quiet when passing the host on', () => {
    const state = party({
      viewers: [
        { userId: HOST, status: 'ready', joinedAt: T0, lastSeenAt: T0 + VIEWER_AWAY_MS },
        { userId: ANA, status: 'ready', joinedAt: T0, lastSeenAt: T0 },
        { userId: BO, status: 'ready', joinedAt: T0, lastSeenAt: T0 + VIEWER_AWAY_MS },
      ],
    });
    const next = act(state, { type: 'leave', actorId: HOST }, T0 + VIEWER_AWAY_MS + 1);
    expect(next.hostId).toBe(BO);
  });

  it('leaves the party hostless when the last person leaves', () => {
    const state = createWatchPartyInitialState({ hostId: HOST, now: T0 });
    const next = act(state, { type: 'leave', actorId: HOST });
    expect(next.viewers).toEqual([]);
    expect(next.hostId).toBeNull();
  });

  it('ignores a leave from someone who is not there', () => {
    const state = party();
    expect(act(state, { type: 'leave', actorId: 'stranger' })).toBe(state);
  });
});

describe('report-status', () => {
  it('records a change', () => {
    const next = act(party(), { type: 'report-status', actorId: ANA, status: 'buffering' }, T0 + 3_000);
    expect(next.viewers.find((v) => v.userId === ANA)).toMatchObject({ status: 'buffering', lastSeenAt: T0 + 3_000 });
    expect(next.stampedAt).toBe(T0 + 3_000);
  });

  it('ignores the same status inside the heartbeat window (no write, no stamp)', () => {
    const state = act(party(), { type: 'report-status', actorId: ANA, status: 'ready' }, T0 + 1_000);
    expect(act(state, { type: 'report-status', actorId: ANA, status: 'ready' }, T0 + 1_000 + HEARTBEAT_MIN_MS - 1)).toBe(state);
  });

  it('refreshes last-seen for the same status after the window (heartbeat)', () => {
    const state = act(party(), { type: 'report-status', actorId: ANA, status: 'ready' }, T0 + 1_000);
    const later = T0 + 1_000 + HEARTBEAT_MIN_MS;
    const next = act(state, { type: 'report-status', actorId: ANA, status: 'ready' }, later);
    expect(next.viewers.find((v) => v.userId === ANA)?.lastSeenAt).toBe(later);
  });

  it('lists a viewer whose join never arrived', () => {
    const next = act(party(), { type: 'report-status', actorId: 'newcomer', status: 'ready' });
    expect(next.viewers.at(-1)).toMatchObject({ userId: 'newcomer', status: 'ready' });
  });

  it('ignores an unlisted viewer when the list is full', () => {
    const viewers = Array.from({ length: VIEWERS_MAX }, (_, i) => ({
      userId: `u${i}`,
      status: 'idle' as const,
      joinedAt: T0,
      lastSeenAt: T0,
    }));
    const state = party({ viewers });
    expect(act(state, { type: 'report-status', actorId: 'late', status: 'ready' })).toBe(state);
  });
});

describe('set-video', () => {
  it('puts a link on screen, paused at its start, for a fresh party', () => {
    const next = act(party(), { type: 'set-video', actorId: HOST, url: url(ID_A, '?t=42') }, T0 + 9);
    expect(next.current).toEqual({ id: 'v1', videoId: ID_A, startSec: 42, addedBy: HOST, addedAt: T0 + 9 });
    expect(next.playback).toEqual({ status: 'paused', positionSec: 42, updatedAt: T0 + 9 });
    expect(next.nextItemSeq).toBe(2);
  });

  it('keeps a playing room playing when the video changes', () => {
    const next = act(watching('playing'), { type: 'set-video', actorId: HOST, url: url('ddddddddddd') }, T0 + 50);
    expect(next.current?.videoId).toBe('ddddddddddd');
    expect(next.current?.id).toBe('v4');
    expect(next.playback).toEqual({ status: 'playing', positionSec: 0, updatedAt: T0 + 50 });
    expect(next.queue).toHaveLength(2); // the queue is untouched
  });

  it('is the host’s call alone — even in "everyone" mode', () => {
    const state = watching('paused', { controlMode: 'everyone' });
    expect(act(state, { type: 'set-video', actorId: ANA, url: url('ddddddddddd') })).toBe(state);
  });

  it('refuses a link that is not a YouTube video', () => {
    const state = party();
    expect(act(state, { type: 'set-video', actorId: HOST, url: 'https://evil.example/x' })).toBe(state);
  });
});

describe('queue-add', () => {
  it('puts the first video straight on screen, paused, whoever adds it', () => {
    const next = act(party(), { type: 'queue-add', actorId: ANA, url: url(ID_A) }, T0 + 4);
    expect(next.current).toMatchObject({ id: 'v1', videoId: ID_A, addedBy: ANA });
    expect(next.queue).toEqual([]);
    expect(next.playback.status).toBe('paused');
  });

  it('queues behind the current video', () => {
    const next = act(watching(), { type: 'queue-add', actorId: HOST, url: url('ddddddddddd') }, T0 + 4);
    expect(next.queue.map((i) => i.videoId)).toEqual([ID_B, ID_C, 'ddddddddddd']);
    expect(next.queue.at(-1)).toMatchObject({ id: 'v4', addedBy: HOST, addedAt: T0 + 4 });
    expect(next.nextItemSeq).toBe(5);
  });

  it('refuses a video that is already queued', () => {
    const state = watching();
    expect(act(state, { type: 'queue-add', actorId: HOST, url: `https://www.youtube.com/shorts/${ID_B}` })).toBe(state);
    expect(queueRefusal(state, HOST, { videoId: ID_B, startSec: 0 })).toBe('duplicate');
  });

  it(`holds a viewer to ${QUEUE_MAX_PER_USER} videos waiting — but not the host`, () => {
    let state = watching('paused', { queue: [] });
    for (let i = 0; i < QUEUE_MAX_PER_USER; i += 1) {
      state = act(state, { type: 'queue-add', actorId: ANA, url: url(`anaVideo00${i}`) });
    }
    expect(state.queue).toHaveLength(QUEUE_MAX_PER_USER);
    const full = state;
    expect(act(full, { type: 'queue-add', actorId: ANA, url: url('anaVideo009') })).toBe(full);
    expect(queueRefusal(full, ANA, { videoId: 'anaVideo009', startSec: 0 })).toBe('perUser');
    // Someone else still can; so can the host, any number of times.
    expect(act(full, { type: 'queue-add', actorId: BO, url: url('boVideo0001') }).queue).toHaveLength(QUEUE_MAX_PER_USER + 1);
    let hosted = full;
    for (let i = 0; i < QUEUE_MAX_PER_USER + 2; i += 1) {
      hosted = act(hosted, { type: 'queue-add', actorId: HOST, url: url(`hostVideo0${i}`) });
    }
    expect(hosted.queue.filter((q) => q.addedBy === HOST)).toHaveLength(QUEUE_MAX_PER_USER + 2);
  });

  it(`stops at ${QUEUE_MAX} videos`, () => {
    const queue = Array.from({ length: QUEUE_MAX }, (_, i) => item(`v${i + 2}`, `queued${String(i).padStart(5, '0')}`));
    const state = watching('paused', { queue, nextItemSeq: QUEUE_MAX + 2 });
    expect(act(state, { type: 'queue-add', actorId: HOST, url: url('onemoreone1') })).toBe(state);
    expect(queueRefusal(state, HOST, { videoId: 'onemoreone1', startSec: 0 })).toBe('full');
  });
});

describe('queue-remove / queue-move / queue-play / skip', () => {
  it('lets the host remove anything', () => {
    expect(act(watching(), { type: 'queue-remove', actorId: HOST, itemId: 'v3' }).queue.map((i) => i.id)).toEqual(['v2']);
  });

  it('lets a viewer remove what they added — and nothing else', () => {
    const state = watching();
    expect(act(state, { type: 'queue-remove', actorId: ANA, itemId: 'v2' }).queue.map((i) => i.id)).toEqual(['v3']);
    expect(act(state, { type: 'queue-remove', actorId: ANA, itemId: 'v3' })).toBe(state);
  });

  it('ignores removing an item that is not queued', () => {
    const state = watching();
    expect(act(state, { type: 'queue-remove', actorId: HOST, itemId: 'v99' })).toBe(state);
  });

  it('reorders for the host only', () => {
    const state = watching();
    expect(act(state, { type: 'queue-move', actorId: HOST, itemId: 'v3', toIndex: 0 }).queue.map((i) => i.id)).toEqual(['v3', 'v2']);
    expect(act(state, { type: 'queue-move', actorId: HOST, itemId: 'v2', toIndex: 20 }).queue.map((i) => i.id)).toEqual(['v3', 'v2']);
    expect(act(state, { type: 'queue-move', actorId: HOST, itemId: 'v2', toIndex: 0 })).toBe(state);
    expect(act(state, { type: 'queue-move', actorId: HOST, itemId: 'v99', toIndex: 0 })).toBe(state);
    expect(act(state, { type: 'queue-move', actorId: ANA, itemId: 'v3', toIndex: 0 })).toBe(state);
  });

  it('plays a queued video now (host), keeping the room paused or playing', () => {
    const next = act(watching('playing'), { type: 'queue-play', actorId: HOST, itemId: 'v3' }, T0 + 77);
    expect(next.current?.id).toBe('v3');
    expect(next.queue.map((i) => i.id)).toEqual(['v2']);
    expect(next.playback).toEqual({ status: 'playing', positionSec: 0, updatedAt: T0 + 77 });
    const state = watching();
    expect(act(state, { type: 'queue-play', actorId: ANA, itemId: 'v3' })).toBe(state);
    expect(act(state, { type: 'queue-play', actorId: HOST, itemId: 'v99' })).toBe(state);
  });

  it('skips to the next video, starting at its start time', () => {
    const state = watching('paused', { queue: [item('v2', ID_B, ANA, 15)] });
    const next = act(state, { type: 'skip', actorId: HOST }, T0 + 88);
    expect(next.current?.id).toBe('v2');
    expect(next.queue).toEqual([]);
    expect(next.playback).toEqual({ status: 'paused', positionSec: 15, updatedAt: T0 + 88 });
  });

  it('does not skip for a viewer, or with nothing queued', () => {
    const state = watching();
    expect(act(state, { type: 'skip', actorId: ANA })).toBe(state);
    const empty = watching('playing', { queue: [] });
    expect(act(empty, { type: 'skip', actorId: HOST })).toBe(empty);
  });
});

describe('video-ended', () => {
  it('moves the room on to the next video, still playing', () => {
    const next = act(watching('playing'), { type: 'video-ended', actorId: HOST, itemId: 'v1' }, T0 + 99);
    expect(next.current?.id).toBe('v2');
    expect(next.playback).toEqual({ status: 'playing', positionSec: 0, updatedAt: T0 + 99 });
  });

  it('pauses at the end when nothing is queued', () => {
    const state = watching('playing', { queue: [] });
    expect(act(state, { type: 'video-ended', actorId: HOST, itemId: 'v1', positionSec: 212.5 }, T0 + 5).playback).toEqual({
      status: 'paused',
      positionSec: 212.5,
      updatedAt: T0 + 5,
    });
    // Without a position, where the shared timeline is.
    expect(act(state, { type: 'video-ended', actorId: HOST, itemId: 'v1' }, T0 + 10_000).playback.positionSec).toBe(40);
  });

  it('counts once: a stale or repeated report changes nothing', () => {
    const moved = act(watching('playing'), { type: 'video-ended', actorId: HOST, itemId: 'v1' });
    expect(act(moved, { type: 'video-ended', actorId: HOST, itemId: 'v1' })).toBe(moved);
  });

  it('is the host’s report only (in "everyone" mode it would be a back-door skip)', () => {
    const state = watching('playing', { controlMode: 'everyone' });
    expect(act(state, { type: 'video-ended', actorId: ANA, itemId: 'v1' })).toBe(state);
  });

  it('means nothing while the room is paused', () => {
    const state = watching('paused');
    expect(act(state, { type: 'video-ended', actorId: HOST, itemId: 'v1' })).toBe(state);
  });
});

describe('play / pause / seek', () => {
  it('plays from where the room paused, stamped with the server time', () => {
    const next = act(watching('paused'), { type: 'play', actorId: HOST }, T0 + 500);
    expect(next.playback).toEqual({ status: 'playing', positionSec: 30, updatedAt: T0 + 500 });
    expect(next.stampedAt).toBe(T0 + 500);
  });

  it('plays from a given position', () => {
    expect(act(watching('paused'), { type: 'play', actorId: HOST, positionSec: 12.3456 }).playback.positionSec).toBe(12.346);
  });

  it('ignores play when already playing, unless a position is given', () => {
    const state = watching('playing');
    expect(act(state, { type: 'play', actorId: HOST })).toBe(state);
    expect(act(state, { type: 'play', actorId: HOST, positionSec: 5 }, T0 + 1).playback).toEqual({
      status: 'playing',
      positionSec: 5,
      updatedAt: T0 + 1,
    });
  });

  it('pauses where the shared timeline is when no position is given', () => {
    // Playing from 30 s since T0; 12.5 s later the timeline is at 42.5 s.
    const next = act(watching('playing'), { type: 'pause', actorId: HOST }, T0 + 12_500);
    expect(next.playback).toEqual({ status: 'paused', positionSec: 42.5, updatedAt: T0 + 12_500 });
  });

  it('pauses at the controller’s position when given', () => {
    expect(act(watching('playing'), { type: 'pause', actorId: HOST, positionSec: 41 }).playback.positionSec).toBe(41);
  });

  it('ignores pause when already paused, unless a position is given', () => {
    const state = watching('paused');
    expect(act(state, { type: 'pause', actorId: HOST })).toBe(state);
    expect(act(state, { type: 'pause', actorId: HOST, positionSec: 3 }).playback.positionSec).toBe(3);
  });

  it('seeks and keeps the play state', () => {
    expect(act(watching('playing'), { type: 'seek', actorId: HOST, positionSec: 100 }, T0 + 3).playback).toEqual({
      status: 'playing',
      positionSec: 100,
      updatedAt: T0 + 3,
    });
    expect(act(watching('paused'), { type: 'seek', actorId: HOST, positionSec: 100 }).playback.status).toBe('paused');
  });

  it('ignores seeking a paused room to where it already is', () => {
    const state = watching('paused');
    expect(act(state, { type: 'seek', actorId: HOST, positionSec: 30 })).toBe(state);
  });

  it('is host-only by default', () => {
    const state = watching('paused');
    for (const action of [
      { type: 'play', actorId: ANA },
      { type: 'pause', actorId: ANA, positionSec: 1 },
      { type: 'seek', actorId: ANA, positionSec: 5 },
    ] as WatchPartyAction[]) {
      expect(act(state, action), action.type).toBe(state);
    }
  });

  it('lets everyone watching control when the host allows it — but not outsiders', () => {
    const state = watching('paused', { controlMode: 'everyone' });
    expect(act(state, { type: 'play', actorId: ANA }).playback.status).toBe('playing');
    expect(act(state, { type: 'seek', actorId: BO, positionSec: 9 }).playback.positionSec).toBe(9);
    expect(act(state, { type: 'play', actorId: 'outsider' })).toBe(state);
  });

  it('needs a video', () => {
    const state = party();
    expect(act(state, { type: 'play', actorId: HOST })).toBe(state);
    expect(act(state, { type: 'pause', actorId: HOST, positionSec: 1 })).toBe(state);
    expect(act(state, { type: 'seek', actorId: HOST, positionSec: 1 })).toBe(state);
  });
});

describe('set-control-mode', () => {
  it('switches for the host; a repeat or a viewer changes nothing', () => {
    const state = watching();
    const everyone = act(state, { type: 'set-control-mode', actorId: HOST, mode: 'everyone' });
    expect(everyone.controlMode).toBe('everyone');
    expect(act(everyone, { type: 'set-control-mode', actorId: HOST, mode: 'everyone' })).toBe(everyone);
    expect(act(state, { type: 'set-control-mode', actorId: ANA, mode: 'everyone' })).toBe(state);
    expect(canControlPlayback(everyone, ANA)).toBe(true);
    expect(canControlPlayback(everyone, 'outsider')).toBe(false);
  });
});

describe('host changes', () => {
  it('transfer-host: the host hands the party to someone watching', () => {
    const next = act(party(), { type: 'transfer-host', actorId: HOST, toUserId: BO }, T0 + 3);
    expect(next.hostId).toBe(BO);
    expect(next.hostSince).toBe(T0 + 3);
  });

  it('transfer-host: not by a viewer, not to oneself, not to someone absent', () => {
    const state = party();
    expect(act(state, { type: 'transfer-host', actorId: ANA, toUserId: BO })).toBe(state);
    expect(act(state, { type: 'transfer-host', actorId: HOST, toUserId: HOST })).toBe(state);
    expect(act(state, { type: 'transfer-host', actorId: HOST, toUserId: 'stranger' })).toBe(state);
  });

  it('claim-host: refused while the host is around', () => {
    const state = party();
    expect(isHostAway(state, T0 + HOST_AWAY_MS)).toBe(false);
    expect(act(state, { type: 'claim-host', actorId: ANA }, T0 + HOST_AWAY_MS)).toBe(state);
  });

  it('claim-host: anyone watching may take over a host gone quiet', () => {
    const state = party();
    const later = T0 + HOST_AWAY_MS + 1;
    expect(isHostAway(state, later)).toBe(true);
    const next = act(state, { type: 'claim-host', actorId: ANA }, later);
    expect(next.hostId).toBe(ANA);
    expect(next.hostSince).toBe(later);
    expect(next.viewers.find((v) => v.userId === ANA)?.lastSeenAt).toBe(later);
  });

  it('claim-host: a host who was just handed the party is not immediately replaceable', () => {
    // BO's last report is old, but they became host a moment ago.
    const quietBo = party({
      viewers: [
        { userId: HOST, status: 'idle', joinedAt: T0, lastSeenAt: T0 },
        { userId: ANA, status: 'idle', joinedAt: T0, lastSeenAt: T0 },
        { userId: BO, status: 'idle', joinedAt: T0, lastSeenAt: T0 },
      ],
    });
    const handedAt = T0 + 10 * 60_000;
    const handed = act(quietBo, { type: 'transfer-host', actorId: HOST, toUserId: BO }, handedAt);
    expect(act(handed, { type: 'claim-host', actorId: ANA }, handedAt + 1_000)).toBe(handed);
    expect(act(handed, { type: 'claim-host', actorId: ANA }, handedAt + HOST_AWAY_MS + 1).hostId).toBe(ANA);
  });

  it('claim-host: a hostless party can be claimed at once; outsiders and the host cannot claim', () => {
    const hostless = party({ hostId: null });
    expect(act(hostless, { type: 'claim-host', actorId: BO }).hostId).toBe(BO);
    expect(act(hostless, { type: 'claim-host', actorId: 'outsider' })).toBe(hostless);
    const state = party();
    expect(act(state, { type: 'claim-host', actorId: HOST }, T0 + HOST_AWAY_MS + 1)).toBe(state);
  });

  it('claim-host: a host who is not on the list counts as away', () => {
    const state = party({ hostId: 'gone' });
    expect(isHostAway(state, T0)).toBe(true);
    expect(act(state, { type: 'claim-host', actorId: ANA }).hostId).toBe(ANA);
  });

  it('take-host: the creator or a moderator (route policy) takes the controls', () => {
    const state = act(party(), { type: 'transfer-host', actorId: HOST, toUserId: ANA });
    const back = act(state, { type: 'take-host', actorId: HOST }, T0 + 9);
    expect(back.hostId).toBe(HOST);
    expect(back.hostSince).toBe(T0 + 9);
    expect(act(back, { type: 'take-host', actorId: HOST })).toBe(back);
  });

  it('take-host: a moderator who was not watching is listed', () => {
    const next = act(party(), { type: 'take-host', actorId: 'moderator' }, T0 + 2);
    expect(next.hostId).toBe('moderator');
    expect(next.viewers.at(-1)).toMatchObject({ userId: 'moderator', joinedAt: T0 + 2 });
  });

  it('take-host: listed even when the list is full, so they are not instantly "away"', () => {
    const viewers = Array.from({ length: VIEWERS_MAX }, (_, i) => ({
      userId: `u${i}`,
      status: 'idle' as const,
      joinedAt: T0,
      lastSeenAt: T0,
    }));
    const next = act(party({ viewers, hostId: 'u0' }), { type: 'take-host', actorId: 'moderator' }, T0 + 2);
    expect(next.viewers).toHaveLength(VIEWERS_MAX + 1);
    expect(isHostAway(next, T0 + 3)).toBe(false);
  });
});

describe('watchPartyHostChange — the session host moved (host left the voice room)', () => {
  it('the party follows when its host was the old session host', () => {
    const next = watchPartyHostChange(party(), { previousHostId: HOST, nextHostId: ANA, now: T0 + 70_000 });
    expect(next.hostId).toBe(ANA);
    expect(next.hostSince).toBe(T0 + 70_000);
    expect(next.stampedAt).toBe(T0 + 70_000);
    expect(next.viewers.find((v) => v.userId === ANA)?.lastSeenAt).toBe(T0 + 70_000);
  });

  it('a party host the room chose since keeps the controls', () => {
    const handed = act(party(), { type: 'transfer-host', actorId: HOST, toUserId: BO }, T0 + 5);
    expect(watchPartyHostChange(handed, { previousHostId: HOST, nextHostId: ANA, now: T0 + 70_000 })).toBe(handed);
  });

  it('…unless that party host has gone quiet too, or there is none', () => {
    const handed = act(party(), { type: 'transfer-host', actorId: HOST, toUserId: BO }, T0 + 5);
    const later = T0 + 5 + HOST_AWAY_MS + 1;
    expect(watchPartyHostChange(handed, { previousHostId: HOST, nextHostId: ANA, now: later }).hostId).toBe(ANA);
    expect(watchPartyHostChange(party({ hostId: null }), { previousHostId: null, nextHostId: ANA, now: T0 + 1 }).hostId).toBe(ANA);
  });

  it('a new host who was not watching is listed (like take-host)', () => {
    const next = watchPartyHostChange(party(), { previousHostId: HOST, nextHostId: 'newcomer', now: T0 + 9 });
    expect(next.hostId).toBe('newcomer');
    expect(next.viewers.at(-1)).toMatchObject({ userId: 'newcomer', joinedAt: T0 + 9, lastSeenAt: T0 + 9 });
  });

  it('no change: already the party host, or a malformed id', () => {
    const state = party({ hostId: ANA });
    expect(watchPartyHostChange(state, { previousHostId: HOST, nextHostId: ANA, now: T0 + 1 })).toBe(state);
    expect(watchPartyHostChange(party(), { previousHostId: HOST, nextHostId: '', now: T0 + 1 })).toEqual(party());
  });

  it('the plugin wires it as onHostChange', () => {
    const next = watchPartyPlugin.onHostChange!(party(), {
      previousHostId: HOST,
      nextHostId: ANA,
      now: T0 + 70_000,
      reason: 'host_left_voice',
    });
    expect(next.hostId).toBe(ANA);
  });
});

describe('positionAt', () => {
  it('advances a playing timeline with server time and holds a paused one', () => {
    expect(positionAt({ status: 'playing', positionSec: 10, updatedAt: T0 }, T0 + 2_500)).toBe(12.5);
    expect(positionAt({ status: 'paused', positionSec: 10, updatedAt: T0 }, T0 + 2_500)).toBe(10);
    // A server clock that stepped back never rewinds the video.
    expect(positionAt({ status: 'playing', positionSec: 10, updatedAt: T0 }, T0 - 5_000)).toBe(10);
  });
});
