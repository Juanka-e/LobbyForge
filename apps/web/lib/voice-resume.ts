/**
 * Coming back to voice after a reload or a dropped connection
 * (docs/ACTIVITY_INTEGRITY_AND_RESILIENCE.md §3.2).
 *
 * A reload is always a new LiveKit connection: livekit-client leaves the
 * room on purpose when the page goes away (`disconnectOnPageLeave`), and
 * nothing used to remember that this tab was in voice. This module is
 * that memory, and the rules around it. It is pure and client-safe: the
 * lobby's voice provider does the joining.
 *
 *  - `sessionStorage['lf.voice.resume.v1']` holds `{ serverId, channelId,
 *    channelName, at }`. sessionStorage is per tab: it survives a reload
 *    and goes when the tab closes, which is exactly the lifetime wanted.
 *    Written when the room reaches Connected, `at` refreshed every 5 s
 *    while connected (and while LiveKit is still trying to reconnect).
 *  - It is cleared when the person leaves or switches channel, and when
 *    the ending must not be undone by coming back on our own (another
 *    tab took over, a moderator removed them, the room is gone, the
 *    server refused voice).
 *  - A duplicated tab copies sessionStorage, so the record alone could
 *    put two tabs in the same room and they would kick each other out.
 *    The tab in voice holds a Web Lock (`lf-voice`); a tab may only come
 *    back on its own when nobody holds it. No Locks API (an old browser,
 *    a plain-HTTP page): no lock, as before.
 *  - `sessionStorage['lf.view.v1']` remembers that the activities view
 *    was open, so a reload reopens it.
 *
 * Every storage access is wrapped: private windows and blocked site data
 * throw, and a failure only means there is nothing to come back to.
 */
import { DisconnectReason, type ReconnectContext, type ReconnectPolicy } from 'livekit-client';
import { VOICE_BLOCKED_CODE } from './voice-block-notice';

export const VOICE_RESUME_KEY = 'lf.voice.resume.v1';
export const LOBBY_VIEW_KEY = 'lf.view.v1';
/** A record older than this is not offered after a reload. */
export const VOICE_RESUME_FRESH_MS = 120_000;
/**
 * The online / tab-visible retry after LiveKit gave up only runs while the
 * tab was in voice (or reconnecting) within this long: coming back to a tab
 * half an hour later must not drop the person into a voice room. The
 * one-click strip stays.
 */
export const VOICE_AUTO_RETRY_MAX_AGE_MS = 10 * 60_000;
/** How often `at` is refreshed while connected. */
export const VOICE_RESUME_HEARTBEAT_MS = 5_000;
/** The Web Lock the tab in voice holds. */
export const VOICE_LOCK_NAME = 'lf-voice';

export interface VoiceResumeRecord {
  serverId: string;
  channelId: string;
  channelName: string;
  /** When this tab was last seen in voice (ms since epoch). */
  at: number;
}

/** The voice channel the lobby offers to go back to. */
export interface VoiceResumeOffer {
  channelId: string;
  channelName: string;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** This tab's sessionStorage, or null where reading it throws (blocked storage). */
function sessionStore(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readJson(storage: StorageLike | null, key: string): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: StorageLike | null, key: string, value: unknown): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(storage: StorageLike | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    /* nothing to clear, then */
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The stored record, or null when there is none or it is malformed. */
export function readVoiceResume(storage: StorageLike | null = sessionStore()): VoiceResumeRecord | null {
  const data = readJson(storage, VOICE_RESUME_KEY) as Partial<VoiceResumeRecord> | null;
  if (!data || typeof data !== 'object') return null;
  if (!nonEmpty(data.serverId) || !nonEmpty(data.channelId)) return null;
  if (typeof data.at !== 'number' || !Number.isFinite(data.at)) return null;
  return {
    serverId: data.serverId,
    channelId: data.channelId,
    channelName: typeof data.channelName === 'string' ? data.channelName : '',
    at: data.at,
  };
}

/** Remember that this tab is in `channelId` now. False when storage refused. */
export function writeVoiceResume(
  record: Omit<VoiceResumeRecord, 'at'>,
  now: number = Date.now(),
  storage: StorageLike | null = sessionStore()
): boolean {
  return writeJson(storage, VOICE_RESUME_KEY, { ...record, at: now });
}

/**
 * The 5-second heartbeat: refresh `at` of the record that is there. Never
 * creates one, so a beat that lands just after a clear changes nothing.
 */
export function touchVoiceResume(now: number = Date.now(), storage: StorageLike | null = sessionStore()): void {
  const record = readVoiceResume(storage);
  if (record) writeJson(storage, VOICE_RESUME_KEY, { ...record, at: now });
}

export function clearVoiceResume(storage: StorageLike | null = sessionStore()): void {
  remove(storage, VOICE_RESUME_KEY);
}

/** May the online / tab-visible retry still rejoin on its own? (A clock moved back counts as recent.) */
export function voiceAutoRetryAllowed(record: Pick<VoiceResumeRecord, 'at'> | null, now: number = Date.now()): boolean {
  if (!record) return false;
  const age = now - record.at;
  return age < VOICE_AUTO_RETRY_MAX_AGE_MS && age > -VOICE_AUTO_RETRY_MAX_AGE_MS;
}

/** Seen in voice within the last two minutes (a clock moved back counts as fresh). */
export function isVoiceResumeFresh(record: Pick<VoiceResumeRecord, 'at'>, now: number = Date.now()): boolean {
  const age = now - record.at;
  return age < VOICE_RESUME_FRESH_MS && age > -VOICE_RESUME_FRESH_MS;
}

/**
 * Endings that clear the record — coming back on our own would undo them:
 *  - DUPLICATE_IDENTITY: another tab or device took over. Coming back
 *    would kick that one out, and the two would take turns forever.
 *  - PARTICIPANT_REMOVED: a moderator (or the voice anti-cheat) removed
 *    this member. An automatic return must not undo moderation.
 *  - ROOM_DELETED: the room is gone.
 * Anything else — LiveKit giving up on a lost network (no reason), a
 * server restart, the page being frozen or left (CLIENT_INITIATED, which
 * is also what a reload sends) — keeps it.
 */
export function voiceResumeClearsOnDisconnect(reason: DisconnectReason | undefined): boolean {
  return (
    reason === DisconnectReason.DUPLICATE_IDENTITY ||
    reason === DisconnectReason.PARTICIPANT_REMOVED ||
    reason === DisconnectReason.ROOM_DELETED
  );
}

/**
 * A refused join (from `/api/livekit/token`) that clears the record: a
 * voice block, a session that is gone (401), a permission the member no
 * longer has or an unverified email (403), a channel that no longer
 * exists (404). Rate limits and server errors keep it: trying again later
 * can work.
 */
export function voiceResumeClearsOnRefusal(status: number, body: unknown): boolean {
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
  if (code === VOICE_BLOCKED_CODE) return true;
  return status === 401 || status === 403 || status === 404;
}

export type VoiceResumePlan =
  /** Nothing stored here (or it belongs to another community's lobby): leave it alone. */
  | { kind: 'none' }
  /** A record that can never be used: delete it. */
  | { kind: 'clear' }
  /** Offer the way back; `auto` joins without waiting for the click. */
  | ({ kind: 'offer'; auto: boolean } & VoiceResumeOffer);

/**
 * What the lobby does with the record it finds when it loads.
 *
 * It offers the way back (one click — also the gesture browsers want
 * before they play audio) when the record is fresh, for this community,
 * for a voice channel this member can still see, and no other tab of this
 * browser is in voice. It goes back on its own only when, as well, this
 * load is a reload and the microphone permission is already granted
 * (Safari and Firefox may not answer that query: then it is one click).
 */
export function planVoiceResume(input: {
  record: VoiceResumeRecord | null;
  serverId: string;
  now: number;
  /** The voice channels this viewer can see; null when not known (no check). */
  channels: ReadonlyArray<{ id: string; name: string }> | null;
  lockHeldElsewhere: boolean;
  /** `PerformanceNavigationTiming.type` of this load. */
  navigationType: string | null;
  microphone: PermissionState | 'unknown';
}): VoiceResumePlan {
  const { record } = input;
  if (!record || record.serverId !== input.serverId) return { kind: 'none' };
  if (!isVoiceResumeFresh(record, input.now)) return { kind: 'clear' };
  let channelName = record.channelName;
  if (input.channels) {
    const channel = input.channels.find((c) => c.id === record.channelId);
    if (!channel) return { kind: 'clear' };
    channelName = channel.name;
  }
  // Another tab is in voice: this one is a copy (a duplicated tab) or the
  // person has moved on — either way, not this tab's call to make.
  if (input.lockHeldElsewhere) return { kind: 'clear' };
  return {
    kind: 'offer',
    channelId: record.channelId,
    channelName,
    auto: input.navigationType === 'reload' && input.microphone === 'granted',
  };
}

/** `reload`, `navigate`, `back_forward`… for this page load; null when unknown. */
export function readNavigationType(): string | null {
  try {
    const entry = globalThis.performance?.getEntriesByType?.('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    return typeof entry?.type === 'string' ? entry.type : null;
  } catch {
    return null;
  }
}

/** The microphone permission, or 'unknown' where the browser will not say (it may throw). */
export async function readMicrophonePermission(): Promise<PermissionState | 'unknown'> {
  try {
    const permissions = globalThis.navigator?.permissions;
    if (!permissions?.query) return 'unknown';
    const status = await permissions.query({ name: 'microphone' as PermissionName });
    return status?.state ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── The cross-tab lock ────────────────────────────────────────────────

/** A claim on the voice lock; `release()` is safe to call more than once. */
export interface VoiceLock {
  release(): void;
}

type LockManagerLike = Pick<LockManager, 'request'> & Partial<Pick<LockManager, 'query'>>;

/** Without the Locks API there is nothing to hold: every tab may go. */
const NO_LOCK: VoiceLock = { release() {} };

function lockManager(): LockManagerLike | null {
  try {
    const locks = globalThis.navigator?.locks;
    return locks && typeof locks.request === 'function' ? locks : null;
  } catch {
    return null;
  }
}

/** How long a lock still held at load may take to go before it counts as another tab's. */
export const VOICE_LOCK_GRACE_MS = 1_500;
const VOICE_LOCK_POLL_MS = 250;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * True when another tab of this browser holds the voice lock (call it
 * before this tab takes it). Right after a reload the page that went away
 * may still be on record for a moment — the browser frees its lock when
 * it has finished tearing it down — so a held lock is looked at again for
 * up to 1.5 s before it counts.
 */
export async function isVoiceLockHeldElsewhere(
  locks: LockManagerLike | null = lockManager(),
  { graceMs = VOICE_LOCK_GRACE_MS, sleep = pause }: { graceMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<boolean> {
  if (!locks?.query) return false;
  for (let waited = 0; ; waited += VOICE_LOCK_POLL_MS) {
    let held: boolean;
    try {
      const snapshot = await locks.query();
      held = (snapshot.held ?? []).some((lock) => lock.name === VOICE_LOCK_NAME);
    } catch {
      return false;
    }
    if (!held) return false;
    if (waited >= graceMs) return true;
    await sleep(VOICE_LOCK_POLL_MS);
  }
}

/**
 * Take the lock if nobody holds it — the gate for coming back on our own.
 * Null when another tab holds it. Without the Locks API: a no-op claim.
 */
export function tryAcquireVoiceLock(locks: LockManagerLike | null = lockManager()): Promise<VoiceLock | null> {
  if (!locks) return Promise.resolve(NO_LOCK);
  return new Promise((resolve) => {
    let free = () => {};
    const held = new Promise<void>((done) => {
      free = done;
    });
    try {
      locks
        .request(VOICE_LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(null);
            return undefined;
          }
          resolve({ release: () => free() });
          return held;
        })
        .catch(() => resolve(NO_LOCK));
    } catch {
      resolve(NO_LOCK);
    }
  });
}

/**
 * Hold the lock while this tab is in voice. If another tab has it (the
 * person joined by hand in two tabs), wait in line; `release()` leaves
 * the line or frees the lock.
 */
export function holdVoiceLock(locks: LockManagerLike | null = lockManager()): VoiceLock {
  if (!locks) return NO_LOCK;
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  let free = () => {};
  const held = new Promise<void>((done) => {
    free = done;
  });
  try {
    locks
      .request(VOICE_LOCK_NAME, controller ? { signal: controller.signal } : {}, () => held)
      .catch(() => {
        /* aborted while waiting, or no lock to be had */
      });
  } catch {
    return NO_LOCK;
  }
  return {
    release: () => {
      controller?.abort();
      free();
    },
  };
}

// ── LiveKit's own reconnecting ────────────────────────────────────────

/** How long LiveKit keeps trying before it gives up (a lift, a tunnel). */
export const VOICE_RECONNECT_WINDOW_MS = 120_000;
/** livekit-client's own first delays; after them, a try every 7 s (+ up to 1 s). */
const FIRST_RECONNECT_DELAYS_MS = [0, 300, 1_200, 2_700, 4_800];
const LATER_RECONNECT_DELAY_MS = 7_000;

/**
 * The delay before reconnect attempt `retryCount`, or null to give up.
 * livekit-client's default gives up after ten tries, about 45–55 s; this
 * keeps its rhythm (and its jitter from the third try on) but goes on
 * until about two minutes have passed since the connection dropped.
 */
export function voiceReconnectDelay(
  context: Pick<ReconnectContext, 'retryCount' | 'elapsedMs'>,
  random: () => number = Math.random
): number | null {
  const base = FIRST_RECONNECT_DELAYS_MS[context.retryCount] ?? LATER_RECONNECT_DELAY_MS;
  if (context.elapsedMs + base > VOICE_RECONNECT_WINDOW_MS) return null;
  return context.retryCount <= 1 ? base : base + random() * 1_000;
}

export class VoiceReconnectPolicy implements ReconnectPolicy {
  constructor(private readonly random: () => number = Math.random) {}

  nextRetryDelayInMs(context: ReconnectContext): number | null {
    return voiceReconnectDelay(context, this.random);
  }
}

// ── The centre column's view ──────────────────────────────────────────

export interface LobbyViewRecord {
  mode: 'activity';
  channelId: string;
}

/** The view to reopen after a reload, or null. */
export function readLobbyView(storage: StorageLike | null = sessionStore()): LobbyViewRecord | null {
  const data = readJson(storage, LOBBY_VIEW_KEY) as Partial<LobbyViewRecord> | null;
  if (!data || typeof data !== 'object' || data.mode !== 'activity' || !nonEmpty(data.channelId)) return null;
  return { mode: 'activity', channelId: data.channelId };
}

export function writeLobbyView(view: LobbyViewRecord, storage: StorageLike | null = sessionStore()): void {
  writeJson(storage, LOBBY_VIEW_KEY, view);
}

export function clearLobbyView(storage: StorageLike | null = sessionStore()): void {
  remove(storage, LOBBY_VIEW_KEY);
}
