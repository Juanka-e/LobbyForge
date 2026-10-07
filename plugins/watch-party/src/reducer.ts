/**
 * Watch Party rules: action validation and the reducer.
 *
 * WHO MAY DO WHAT is decided here, not by the host's action policies.
 * The host's `host` policy means "the person who STARTED the session"
 * (plus moderators with START_ACTIVITY), but a party's host changes hands
 * — when they leave, when they pass it on, when they vanish. So nearly
 * every action is `member` at the route (any member who can see the
 * channel reaches the reducer) and the reducer checks the actor against
 * `state.hostId` / `state.controlMode`. The one exception is `take-host`,
 * which deliberately uses the route's `host` policy: the session's
 * creator and moderators can always take the controls back.
 *
 * TIME: `now` is the server's clock, passed in by `handleAction`. No
 * action carries a timestamp; `positionSec` is a position in the video.
 *
 * NO-OPS return the SAME state object. The host still persists what the
 * reducer returns, but an unchanged state keeps `stampedAt` (and so every
 * client's clock estimate) untouched.
 */

import {
  HEARTBEAT_MIN_MS,
  HOST_AWAY_MS,
  POSITION_MAX_SEC,
  QUEUE_MAX,
  QUEUE_MAX_PER_USER,
  VIEWER_AWAY_MS,
  VIEWERS_MAX,
} from './constants';
import {
  ITEM_SEQ_MAX,
  clampPosition,
  isItemId,
  isUserId,
  type WatchPartyControlMode,
  type WatchPartyItem,
  type WatchPartyPlayback,
  type WatchPartyState,
  type WatchPartyViewer,
  type WatchPartyViewerStatus,
} from './state';
import { YOUTUBE_URL_MAX_LENGTH, parseYouTubeUrl, youTubeLinkProblem, type YouTubeLink } from './youtube';

/**
 * Every action names its actor in `actorId`. Clients never send it: the
 * host overwrites it with the authenticated caller (`actorFields`).
 */
export type WatchPartyAction =
  | { type: 'join'; actorId: string }
  | { type: 'leave'; actorId: string }
  | { type: 'report-status'; actorId: string; status: WatchPartyViewerStatus }
  | { type: 'set-video'; actorId: string; url: string }
  | { type: 'queue-add'; actorId: string; url: string }
  | { type: 'queue-remove'; actorId: string; itemId: string }
  | { type: 'queue-move'; actorId: string; itemId: string; toIndex: number }
  | { type: 'queue-play'; actorId: string; itemId: string }
  | { type: 'skip'; actorId: string }
  | { type: 'video-ended'; actorId: string; itemId: string; positionSec?: number }
  | { type: 'play'; actorId: string; positionSec?: number }
  | { type: 'pause'; actorId: string; positionSec?: number }
  | { type: 'seek'; actorId: string; positionSec: number }
  | { type: 'set-control-mode'; actorId: string; mode: WatchPartyControlMode }
  | { type: 'transfer-host'; actorId: string; toUserId: string }
  | { type: 'claim-host'; actorId: string }
  | { type: 'take-host'; actorId: string };

export type WatchPartyActionType = WatchPartyAction['type'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What the panel dispatches — the host adds `actorId`. */
export type WatchPartyClientAction = DistributiveOmit<WatchPartyAction, 'actorId'>;

export const WATCH_PARTY_ACTION_TYPES: readonly WatchPartyActionType[] = [
  'join',
  'leave',
  'report-status',
  'set-video',
  'queue-add',
  'queue-remove',
  'queue-move',
  'queue-play',
  'skip',
  'video-ended',
  'play',
  'pause',
  'seek',
  'set-control-mode',
  'transfer-host',
  'claim-host',
  'take-host',
];

const ACTION_TYPES = new Set<string>(WATCH_PARTY_ACTION_TYPES);

/** The refusal a bad link gets — shown to whoever sent it. */
export const LINK_ERROR =
  'Only YouTube video links are supported: youtube.com/watch?v=…, youtu.be/…, youtube.com/shorts/… or youtube.com/embed/….';

/** The refusal an over-long link gets (it may well be a YouTube link — just far too long). */
export const LINK_TOO_LONG_ERROR = `The link is too long: at most ${YOUTUBE_URL_MAX_LENGTH} characters.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= POSITION_MAX_SEC;
}

/**
 * The outer belt: the host calls this on the NORMALIZED action (with
 * `actorId` already injected) and answers 400 with the message. The
 * reducer runs it again — it never trusts shape either.
 */
export function validateWatchPartyAction(action: unknown): string | null {
  if (!isRecord(action)) return 'Action must be an object.';
  const type = action.type;
  if (typeof type !== 'string' || !ACTION_TYPES.has(type)) return `Unknown action type: ${String(type)}`;
  if (!isUserId(action.actorId)) return `${type} requires an actorId (set by the host).`;
  switch (type) {
    case 'report-status':
      return action.status === 'ready' || action.status === 'buffering' || action.status === 'idle'
        ? null
        : 'status must be "ready", "buffering" or "idle".';
    case 'set-video':
    case 'queue-add': {
      const problem = youTubeLinkProblem(action.url);
      return problem === 'tooLong' ? LINK_TOO_LONG_ERROR : problem ? LINK_ERROR : null;
    }
    case 'queue-remove':
    case 'queue-play':
      return isItemId(action.itemId) ? null : `${type} requires an itemId.`;
    case 'queue-move':
      if (!isItemId(action.itemId)) return 'queue-move requires an itemId.';
      return typeof action.toIndex === 'number' &&
        Number.isInteger(action.toIndex) &&
        action.toIndex >= 0 &&
        action.toIndex < QUEUE_MAX
        ? null
        : `toIndex must be a whole number from 0 to ${QUEUE_MAX - 1}.`;
    case 'video-ended':
      if (!isItemId(action.itemId)) return 'video-ended requires an itemId.';
      return action.positionSec === undefined || isPosition(action.positionSec)
        ? null
        : `positionSec must be between 0 and ${POSITION_MAX_SEC}.`;
    case 'play':
    case 'pause':
      return action.positionSec === undefined || isPosition(action.positionSec)
        ? null
        : `positionSec must be between 0 and ${POSITION_MAX_SEC}.`;
    case 'seek':
      return isPosition(action.positionSec) ? null : `positionSec must be between 0 and ${POSITION_MAX_SEC}.`;
    case 'set-control-mode':
      return action.mode === 'host' || action.mode === 'everyone' ? null : 'mode must be "host" or "everyone".';
    case 'transfer-host':
      return isUserId(action.toUserId) ? null : 'transfer-host requires a toUserId.';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Questions about the state (exported: the panel asks the same ones)
// ---------------------------------------------------------------------------

export function findViewer(state: WatchPartyState, userId: string | null | undefined): WatchPartyViewer | undefined {
  return userId ? state.viewers.find((v) => v.userId === userId) : undefined;
}

export function isPartyHost(state: WatchPartyState, userId: string | null | undefined): boolean {
  return Boolean(userId) && state.hostId === userId;
}

/** May this person play, pause and seek? The host always; everyone watching when the host allows it. */
export function canControlPlayback(state: WatchPartyState, userId: string | null | undefined): boolean {
  if (isPartyHost(state, userId)) return true;
  return state.controlMode === 'everyone' && findViewer(state, userId) !== undefined;
}

export function isViewerAway(viewer: WatchPartyViewer, now: number): boolean {
  return now - viewer.lastSeenAt > VIEWER_AWAY_MS;
}

/**
 * Nobody is running the party: no host, a host who is not watching, or a
 * host silent for longer than HOST_AWAY_MS since they last reported (or
 * got the role). Anyone watching may then take over.
 */
export function isHostAway(state: WatchPartyState, now: number): boolean {
  if (state.hostId === null) return true;
  const host = findViewer(state, state.hostId);
  if (!host) return true;
  return now - Math.max(host.lastSeenAt, state.hostSince) > HOST_AWAY_MS;
}

/** Where the shared timeline is at server time `now`. */
export function positionAt(playback: WatchPartyPlayback, now: number): number {
  const elapsed = playback.status === 'playing' ? Math.max(0, now - playback.updatedAt) / 1000 : 0;
  return clampPosition(playback.positionSec + elapsed);
}

export function queuedBy(state: WatchPartyState, userId: string): number {
  return state.queue.filter((item) => item.addedBy === userId).length;
}

/** Why `userId` cannot queue `link` right now, or null when they can (the panel explains; the reducer refuses). */
export function queueRefusal(
  state: WatchPartyState,
  userId: string,
  link: YouTubeLink
): 'full' | 'duplicate' | 'perUser' | null {
  if (state.current === null) return null; // goes straight on screen
  if (state.queue.length >= QUEUE_MAX) return 'full';
  if (state.queue.some((item) => item.videoId === link.videoId)) return 'duplicate';
  if (!isPartyHost(state, userId) && queuedBy(state, userId) >= QUEUE_MAX_PER_USER) return 'perUser';
  return null;
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/** Every real change is stamped with the server time — the clients' clock reference. */
function changed(state: WatchPartyState, patch: Partial<WatchPartyState>, now: number): WatchPartyState {
  return { ...state, ...patch, stampedAt: now };
}

function withViewer(
  viewers: WatchPartyViewer[],
  userId: string,
  patch: Partial<WatchPartyViewer>
): WatchPartyViewer[] {
  return viewers.map((viewer) => (viewer.userId === userId ? { ...viewer, ...patch } : viewer));
}

function newItem(state: WatchPartyState, link: YouTubeLink, addedBy: string, now: number): WatchPartyItem {
  return { id: `v${state.nextItemSeq}`, videoId: link.videoId, startSec: link.startSec, addedBy, addedAt: now };
}

/**
 * Put `item` on screen. The room keeps playing or stays paused: "next"
 * while watching carries on, while a fresh party waits for the host's play.
 */
function onScreen(state: WatchPartyState, item: WatchPartyItem, now: number): Partial<WatchPartyState> {
  return {
    current: item,
    playback: { status: state.current ? state.playback.status : 'paused', positionSec: item.startSec, updatedAt: now },
  };
}

function join(state: WatchPartyState, actor: string, now: number): WatchPartyState {
  const existing = findViewer(state, actor);
  if (existing) {
    // Re-opening the panel: a heartbeat at most.
    if (now - existing.lastSeenAt < HEARTBEAT_MIN_MS) return state;
    return changed(state, { viewers: withViewer(state.viewers, actor, { lastSeenAt: now }) }, now);
  }
  if (state.viewers.length >= VIEWERS_MAX) return state;
  const viewers = [...state.viewers, { userId: actor, status: 'idle' as const, joinedAt: now, lastSeenAt: now }];
  // A party nobody is running goes to whoever turns up.
  if (state.hostId === null) return changed(state, { viewers, hostId: actor, hostSince: now }, now);
  return changed(state, { viewers }, now);
}

function leave(state: WatchPartyState, actor: string, now: number): WatchPartyState {
  const listed = findViewer(state, actor) !== undefined;
  if (!listed && state.hostId !== actor) return state;
  const viewers = state.viewers.filter((viewer) => viewer.userId !== actor);
  if (state.hostId !== actor) return changed(state, { viewers }, now);
  // The host left: the longest-present viewer who is still around takes over.
  const next = viewers.find((viewer) => !isViewerAway(viewer, now)) ?? viewers[0] ?? null;
  return changed(state, { viewers, hostId: next?.userId ?? null, hostSince: now }, now);
}

function reportStatus(
  state: WatchPartyState,
  actor: string,
  status: WatchPartyViewerStatus,
  now: number
): WatchPartyState {
  const existing = findViewer(state, actor);
  if (!existing) {
    // A report from someone not listed (their join was lost) joins them.
    const joined = join(state, actor, now);
    if (joined === state) return state;
    return changed(joined, { viewers: withViewer(joined.viewers, actor, { status }) }, now);
  }
  // Same news again within the heartbeat window: nothing to write.
  if (existing.status === status && now - existing.lastSeenAt < HEARTBEAT_MIN_MS) return state;
  return changed(state, { viewers: withViewer(state.viewers, actor, { status, lastSeenAt: now }) }, now);
}

/**
 * The SESSION's host moved: the old one left the voice room and the host
 * (the app) handed the session to the longest-present participant in it —
 * the same rule `leave` applies inside the party. The party follows when
 * its host was that old session host, or nobody was running the party (no
 * host, or one silent past HOST_AWAY_MS): the new host takes the controls
 * exactly as `take-host` would. A party host the room chose since
 * (transfer-host, claim-host) keeps them. Returns the SAME state when
 * nothing changes.
 */
export function watchPartyHostChange(
  state: WatchPartyState,
  change: { previousHostId: string | null; nextHostId: string; now: number }
): WatchPartyState {
  const next = change.nextHostId;
  const { now } = change;
  if (!isUserId(next) || state.hostId === next) return state;
  const follows = state.hostId === null || state.hostId === change.previousHostId || isHostAway(state, now);
  if (!follows) return state;
  const listed = findViewer(state, next) !== undefined;
  const viewers =
    listed || state.viewers.length > VIEWERS_MAX
      ? withViewer(state.viewers, next, { lastSeenAt: now })
      : [...state.viewers, { userId: next, status: 'idle' as const, joinedAt: now, lastSeenAt: now }];
  return changed(state, { hostId: next, hostSince: now, viewers }, now);
}

export function watchPartyReducer(state: WatchPartyState, action: WatchPartyAction, now: number): WatchPartyState {
  // Defense in depth: validateAction guards the API boundary, but the
  // reducer never trusts shape either.
  if (validateWatchPartyAction(action) !== null) return state;
  const actor = action.actorId;

  switch (action.type) {
    case 'join':
      return join(state, actor, now);

    case 'leave':
      return leave(state, actor, now);

    case 'report-status':
      return reportStatus(state, actor, action.status, now);

    case 'set-video': {
      if (!isPartyHost(state, actor) || state.nextItemSeq > ITEM_SEQ_MAX) return state;
      const link = parseYouTubeUrl(action.url);
      if (!link) return state;
      const item = newItem(state, link, actor, now);
      return changed(state, { ...onScreen(state, item, now), nextItemSeq: state.nextItemSeq + 1 }, now);
    }

    case 'queue-add': {
      const link = parseYouTubeUrl(action.url);
      if (!link || state.nextItemSeq > ITEM_SEQ_MAX) return state;
      if (queueRefusal(state, actor, link) !== null) return state;
      const item = newItem(state, link, actor, now);
      if (state.current === null) {
        // Nothing on screen yet: the first video anyone adds goes straight
        // up, paused, for the host to start when people are ready.
        return changed(state, { ...onScreen(state, item, now), nextItemSeq: state.nextItemSeq + 1 }, now);
      }
      return changed(state, { queue: [...state.queue, item], nextItemSeq: state.nextItemSeq + 1 }, now);
    }

    case 'queue-remove': {
      const item = state.queue.find((entry) => entry.id === action.itemId);
      // The host runs the queue; anyone may take back what they added.
      if (!item || (!isPartyHost(state, actor) && item.addedBy !== actor)) return state;
      return changed(state, { queue: state.queue.filter((entry) => entry.id !== item.id) }, now);
    }

    case 'queue-move': {
      if (!isPartyHost(state, actor)) return state;
      const from = state.queue.findIndex((entry) => entry.id === action.itemId);
      if (from < 0) return state;
      const to = Math.min(state.queue.length - 1, action.toIndex);
      if (to === from) return state;
      const queue = [...state.queue];
      const [item] = queue.splice(from, 1);
      queue.splice(to, 0, item!);
      return changed(state, { queue }, now);
    }

    case 'queue-play': {
      if (!isPartyHost(state, actor)) return state;
      const item = state.queue.find((entry) => entry.id === action.itemId);
      if (!item) return state;
      return changed(
        state,
        { ...onScreen(state, item, now), queue: state.queue.filter((entry) => entry.id !== item.id) },
        now
      );
    }

    case 'skip': {
      if (!isPartyHost(state, actor) || state.queue.length === 0) return state;
      const [next, ...rest] = state.queue;
      return changed(state, { ...onScreen(state, next!, now), queue: rest }, now);
    }

    case 'video-ended': {
      // Reported by the HOST's player only — in "everyone" mode a viewer
      // could otherwise skip with it, and skipping is the host's call.
      if (!isPartyHost(state, actor)) return state;
      if (state.current?.id !== action.itemId || state.playback.status !== 'playing') return state;
      if (state.queue.length > 0) {
        const [next, ...rest] = state.queue;
        return changed(state, { ...onScreen(state, next!, now), queue: rest }, now);
      }
      const positionSec =
        action.positionSec !== undefined ? clampPosition(action.positionSec) : positionAt(state.playback, now);
      return changed(state, { playback: { status: 'paused', positionSec, updatedAt: now } }, now);
    }

    case 'play': {
      if (!state.current || !canControlPlayback(state, actor)) return state;
      if (state.playback.status === 'playing' && action.positionSec === undefined) return state;
      const positionSec =
        action.positionSec !== undefined ? clampPosition(action.positionSec) : positionAt(state.playback, now);
      return changed(state, { playback: { status: 'playing', positionSec, updatedAt: now } }, now);
    }

    case 'pause': {
      if (!state.current || !canControlPlayback(state, actor)) return state;
      if (state.playback.status === 'paused' && action.positionSec === undefined) return state;
      // Without a position, pause where the shared timeline is now.
      const positionSec =
        action.positionSec !== undefined ? clampPosition(action.positionSec) : positionAt(state.playback, now);
      return changed(state, { playback: { status: 'paused', positionSec, updatedAt: now } }, now);
    }

    case 'seek': {
      if (!state.current || !canControlPlayback(state, actor)) return state;
      const positionSec = clampPosition(action.positionSec);
      if (state.playback.status === 'paused' && state.playback.positionSec === positionSec) return state;
      return changed(state, { playback: { status: state.playback.status, positionSec, updatedAt: now } }, now);
    }

    case 'set-control-mode': {
      if (!isPartyHost(state, actor) || state.controlMode === action.mode) return state;
      return changed(state, { controlMode: action.mode }, now);
    }

    case 'transfer-host': {
      if (!isPartyHost(state, actor) || action.toUserId === actor) return state;
      if (!findViewer(state, action.toUserId)) return state;
      return changed(state, { hostId: action.toUserId, hostSince: now }, now);
    }

    case 'claim-host': {
      if (isPartyHost(state, actor) || !findViewer(state, actor) || !isHostAway(state, now)) return state;
      return changed(
        state,
        { hostId: actor, hostSince: now, viewers: withViewer(state.viewers, actor, { lastSeenAt: now }) },
        now
      );
    }

    case 'take-host': {
      // Route policy `host`: only the session's creator or a moderator
      // reaches this line.
      if (isPartyHost(state, actor)) return state;
      const listed = findViewer(state, actor) !== undefined;
      // Room for them in the list even when it is full, so they are not
      // immediately "away" (and replaceable) for want of a line.
      const viewers =
        listed || state.viewers.length > VIEWERS_MAX
          ? withViewer(state.viewers, actor, { lastSeenAt: now })
          : [...state.viewers, { userId: actor, status: 'idle' as const, joinedAt: now, lastSeenAt: now }];
      return changed(state, { hostId: actor, hostSince: now, viewers }, now);
    }

    default:
      return state;
  }
}
