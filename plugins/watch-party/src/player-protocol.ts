/**
 * The YouTube embed's postMessage protocol — what YouTube's own
 * `iframe_api` does, without loading it (the app's CSP allows no
 * third-party script, and that stays so).
 *
 * Out (parent → player), as JSON strings posted to the embed's origin:
 *   { event: 'listening', id, channel: 'widget' }         repeated until the player answers
 *   { event: 'command', func, args, id, channel: 'widget' }   playVideo / pauseVideo / seekTo / addEventListener
 *
 * In (player → parent), JSON strings from https://www.youtube-nocookie.com:
 *   initialDelivery / infoDelivery   { info: { playerState, currentTime, currentTimeLastUpdated_, duration, playbackRate, videoData } }
 *   onReady, onStateChange (info = state code), onError (info = error code)
 *   readyToListen (say 'listening' again), alreadyInitialized
 *
 * Everything that arrives is untrusted input: the panel checks the
 * message's origin AND that it came from its own iframe before this
 * parser sees it, and the parser keeps only well-typed fields.
 */

/** The player's state codes (YT.PlayerState). */
export const PLAYER_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

const KNOWN_STATES = new Set<number>(Object.values(PLAYER_STATE));

export type PlayerCommand = 'playVideo' | 'pauseVideo' | 'seekTo' | 'addEventListener';

export function listeningMessage(widgetId: number): string {
  return JSON.stringify({ event: 'listening', id: widgetId, channel: 'widget' });
}

export function commandMessage(func: PlayerCommand, args: unknown[], widgetId: number): string {
  return JSON.stringify({ event: 'command', func, args, id: widgetId, channel: 'widget' });
}

export interface PlayerInfoUpdate {
  playerState?: number;
  currentTime?: number;
  /** The player's `Date.now() / 1000` when `currentTime` was measured. */
  currentTimeLastUpdated?: number;
  duration?: number;
  playbackRate?: number;
  videoId?: string;
  title?: string;
}

export type PlayerMessage =
  | { kind: 'info'; info: PlayerInfoUpdate; initial: boolean }
  | { kind: 'state'; state: number }
  | { kind: 'error'; code: number }
  | { kind: 'ready' }
  /** `readyToListen`: the player wants the 'listening' handshake again. */
  | { kind: 'listen-again' }
  /** Anything else from the player — it is alive, nothing more. */
  | { kind: 'other' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function readInfo(raw: Record<string, unknown>): PlayerInfoUpdate {
  const info: PlayerInfoUpdate = {};
  if (finite(raw.playerState) && KNOWN_STATES.has(raw.playerState)) info.playerState = raw.playerState;
  if (finite(raw.currentTime) && raw.currentTime >= 0) info.currentTime = raw.currentTime;
  if (finite(raw.currentTimeLastUpdated_) && raw.currentTimeLastUpdated_ > 0) {
    info.currentTimeLastUpdated = raw.currentTimeLastUpdated_;
  }
  if (finite(raw.duration) && raw.duration >= 0) info.duration = raw.duration;
  if (finite(raw.playbackRate) && raw.playbackRate > 0 && raw.playbackRate <= 4) info.playbackRate = raw.playbackRate;
  if (isRecord(raw.videoData)) {
    const { video_id: videoId, title } = raw.videoData;
    if (typeof videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(videoId)) info.videoId = videoId;
    if (typeof title === 'string') info.title = title.slice(0, 300);
  }
  return info;
}

/** A player message, or null for anything that is not one (other frames' traffic, junk). */
export function parsePlayerMessage(data: unknown): PlayerMessage | null {
  let message: unknown = data;
  if (typeof data === 'string') {
    if (data.length > 100_000) return null;
    try {
      message = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!isRecord(message) || typeof message.event !== 'string') return null;
  switch (message.event) {
    case 'initialDelivery':
    case 'infoDelivery':
      return isRecord(message.info)
        ? { kind: 'info', info: readInfo(message.info), initial: message.event === 'initialDelivery' }
        : { kind: 'other' };
    case 'onStateChange':
      return finite(message.info) && KNOWN_STATES.has(message.info) ? { kind: 'state', state: message.info } : { kind: 'other' };
    case 'onError':
      return finite(message.info) ? { kind: 'error', code: message.info } : { kind: 'other' };
    case 'onReady':
      return { kind: 'ready' };
    case 'readyToListen':
      return { kind: 'listen-again' };
    default:
      return { kind: 'other' };
  }
}

// ---------------------------------------------------------------------------
// The player as the panel knows it
// ---------------------------------------------------------------------------

export interface PlayerSnapshot {
  /** The player has answered at least once. */
  connected: boolean;
  state: number | null;
  currentTime: number | null;
  /** Local ms when `currentTime` was true. */
  measuredAt: number;
  duration: number | null;
  rate: number;
  videoId: string | null;
  title: string | null;
  error: number | null;
}

export const EMPTY_PLAYER: PlayerSnapshot = {
  connected: false,
  state: null,
  currentTime: null,
  measuredAt: 0,
  duration: null,
  rate: 1,
  videoId: null,
  title: null,
  error: null,
};

/** Fold one message into what we know about the player. Returns `prev` when nothing changed. */
export function applyPlayerMessage(prev: PlayerSnapshot, message: PlayerMessage, nowMs: number): PlayerSnapshot {
  const next: PlayerSnapshot = { ...prev, connected: true };
  switch (message.kind) {
    case 'info': {
      const { info } = message;
      if (info.playerState !== undefined) next.state = info.playerState;
      if (info.duration !== undefined && info.duration > 0) next.duration = info.duration;
      if (info.playbackRate !== undefined) next.rate = info.playbackRate;
      if (info.videoId !== undefined) next.videoId = info.videoId;
      if (info.title !== undefined) next.title = info.title || null;
      if (info.currentTime !== undefined) {
        next.currentTime = info.currentTime;
        // The player's clock is this machine's clock; trust its measuring
        // moment unless it is implausible, then use the arrival time.
        const measured = info.currentTimeLastUpdated !== undefined ? info.currentTimeLastUpdated * 1000 : nowMs;
        next.measuredAt = Math.abs(measured - nowMs) <= 5_000 ? measured : nowMs;
      }
      // A player that plays again has got past whatever error it showed.
      if (next.state === PLAYER_STATE.PLAYING) next.error = null;
      break;
    }
    case 'state':
      next.state = message.state;
      if (message.state === PLAYER_STATE.PLAYING) next.error = null;
      break;
    case 'error':
      next.error = message.code;
      break;
    default:
      break;
  }
  const same = (Object.keys(next) as Array<keyof PlayerSnapshot>).every((key) => next[key] === prev[key]);
  return same ? prev : next;
}

/** The player's position at `nowMs`: its last report, moved on by the time since if it is playing. */
export function playerTimeAt(player: PlayerSnapshot, nowMs: number): number | null {
  if (player.currentTime === null) return null;
  if (player.state !== PLAYER_STATE.PLAYING) return player.currentTime;
  // Like YouTube's own getCurrentTime: extrapolate, but never by more than
  // a short step — reports arrive several times a second while playing.
  const elapsed = Math.max(0, (nowMs - player.measuredAt) / 1000) * player.rate;
  return player.currentTime + Math.min(elapsed, 2);
}

/** YouTube's error codes, grouped by what the viewer can do about them. */
export type PlayerErrorKind = 'notEmbeddable' | 'notFound' | 'badLink' | 'failed';

export function playerErrorKind(code: number): PlayerErrorKind {
  if (code === 101 || code === 150) return 'notEmbeddable';
  if (code === 100) return 'notFound';
  if (code === 2) return 'badLink';
  return 'failed';
}
