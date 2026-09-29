/**
 * Watch Party state — the shape the server stores and every viewer
 * receives (nothing in it is secret, so it is not projected per viewer:
 * see docs/WATCH_PARTY.md → "Projection").
 *
 * Time is SERVER time. Every timestamp here (`playback.updatedAt`,
 * `joinedAt`, `lastSeenAt`, `stampedAt`) is written by the reducer, which
 * runs on the server inside the actions route — never taken from a
 * client. Clients compare them to their own clock through an offset they
 * derive from `stampedAt` (see `sync.ts`).
 */

import {
  POSITION_MAX_SEC,
  QUEUE_MAX,
  USER_ID_MAX_LENGTH,
  VIEWERS_MAX,
} from './constants';
import { isYouTubeVideoId } from './youtube';

export const WATCH_PARTY_STATE_VERSION = 1;

export type WatchPartyPlaybackStatus = 'playing' | 'paused';

/**
 * The shared timeline: at server time `updatedAt` the video was at
 * `positionSec`, and it has been advancing since if `status` is playing.
 * Every client's expected position is derived from these three numbers.
 */
export interface WatchPartyPlayback {
  status: WatchPartyPlaybackStatus;
  positionSec: number;
  /** Server epoch milliseconds when this record was written. */
  updatedAt: number;
}

/** What a viewer's own player is doing: loaded and following, loading, or not playing along. */
export type WatchPartyViewerStatus = 'ready' | 'buffering' | 'idle';

export interface WatchPartyViewer {
  userId: string;
  status: WatchPartyViewerStatus;
  /** Server ms. The list is in join order; the earliest present viewer inherits the host. */
  joinedAt: number;
  /** Server ms of this viewer's last join, report or heartbeat. */
  lastSeenAt: number;
}

export interface WatchPartyItem {
  /** `v1`, `v2`, … — unique within the session. */
  id: string;
  /** An 11-character YouTube video id — never a URL. */
  videoId: string;
  /** Where playback starts (from `?t=` in the pasted link). */
  startSec: number;
  addedBy: string;
  /** Server ms. */
  addedAt: number;
}

/** Who may play, pause and seek: only the host, or everyone watching. */
export type WatchPartyControlMode = 'host' | 'everyone';

export interface WatchPartyState {
  version: typeof WATCH_PARTY_STATE_VERSION;
  /** The person running the party. Transferable, unlike the session's creator. */
  hostId: string | null;
  /**
   * Server ms when the current host got the role. A host counts as away
   * only after HOST_AWAY_MS without a sign of life SINCE then, so someone
   * handed the party is not replaceable the moment they receive it.
   */
  hostSince: number;
  controlMode: WatchPartyControlMode;
  /** The video on screen, or null before one is chosen. */
  current: WatchPartyItem | null;
  playback: WatchPartyPlayback;
  /** "Up next", in play order. */
  queue: WatchPartyItem[];
  /** People with the panel open, in join order. */
  viewers: WatchPartyViewer[];
  /** The number the next item's id gets. */
  nextItemSeq: number;
  /**
   * Server ms of the last change of any kind. Each client compares it
   * with its own clock when a change arrives — that is how it learns
   * its clock offset without a single extra request.
   */
  stampedAt: number;
}

export function createWatchPartyInitialState(input: { hostId: string | null; now: number }): WatchPartyState {
  const { hostId, now } = input;
  return {
    version: WATCH_PARTY_STATE_VERSION,
    hostId,
    hostSince: now,
    controlMode: 'host',
    current: null,
    playback: { status: 'paused', positionSec: 0, updatedAt: now },
    queue: [],
    // Whoever started the party is watching it.
    viewers: hostId ? [{ userId: hostId, status: 'idle', joinedAt: now, lastSeenAt: now }] : [],
    nextItemSeq: 1,
    stampedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Normalisation — the migration seam (GamePlugin.migrateState), also run by
// the panel: the realtime gateway forwards the stored state as-is, so a
// client can see a row an older build wrote.
//
// Idempotent and deterministic: it never reads the clock (a garbage row
// becomes a fresh party with timestamps of 0), and normalising twice gives
// the same result as normalising once.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= USER_ID_MAX_LENGTH;
}

/** A timestamp in ms, or 0 when it is not one. */
function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** A position in seconds within [0, 12 h], to the millisecond. */
export function clampPosition(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.round(Math.min(POSITION_MAX_SEC, Math.max(0, value)) * 1000) / 1000;
}

const ITEM_ID = /^v(\d{1,9})$/;
/** The largest sequence an item id can carry (`v` + 9 digits). */
export const ITEM_SEQ_MAX = 999_999_999;

export function isItemId(value: unknown): value is string {
  return typeof value === 'string' && ITEM_ID.test(value);
}

function normalizeItem(raw: unknown): WatchPartyItem | null {
  if (!isRecord(raw)) return null;
  if (!isItemId(raw.id) || !isYouTubeVideoId(raw.videoId) || !isUserId(raw.addedBy)) return null;
  return {
    id: raw.id,
    videoId: raw.videoId,
    startSec: Math.floor(clampPosition(raw.startSec)),
    addedBy: raw.addedBy,
    addedAt: timestamp(raw.addedAt),
  };
}

function normalizeViewer(raw: unknown): WatchPartyViewer | null {
  if (!isRecord(raw) || !isUserId(raw.userId)) return null;
  const status: WatchPartyViewerStatus =
    raw.status === 'ready' || raw.status === 'buffering' ? raw.status : 'idle';
  return { userId: raw.userId, status, joinedAt: timestamp(raw.joinedAt), lastSeenAt: timestamp(raw.lastSeenAt) };
}

function itemSeq(item: WatchPartyItem): number {
  return Number(ITEM_ID.exec(item.id)?.[1] ?? 0);
}

/**
 * The M16 stub stored `{ videoId, isPlaying, positionSeconds, hostId,
 * participants }`. It was never registered, so no such row should exist —
 * but a migrator that meets one keeps what it can rather than failing.
 */
function upgradeFromStub(raw: Record<string, unknown>): Record<string, unknown> {
  const hostId = isUserId(raw.hostId) ? raw.hostId : null;
  const videoId = isYouTubeVideoId(raw.videoId) ? raw.videoId : null;
  const participants = Array.isArray(raw.participants) ? raw.participants.filter(isUserId) : [];
  return {
    hostId,
    controlMode: 'host',
    current: videoId ? { id: 'v1', videoId, startSec: 0, addedBy: hostId ?? 'unknown', addedAt: 0 } : null,
    // The stub never recorded WHEN it started playing, so its timeline
    // cannot be continued: it resumes paused where it was.
    playback: { status: 'paused', positionSec: raw.positionSeconds, updatedAt: 0 },
    queue: [],
    viewers: participants.map((userId) => ({ userId, status: 'idle', joinedAt: 0, lastSeenAt: 0 })),
    nextItemSeq: 2,
    stampedAt: 0,
  };
}

export function normalizeWatchPartyState(raw: unknown): WatchPartyState {
  if (!isRecord(raw)) return createWatchPartyInitialState({ hostId: null, now: 0 });
  const source = typeof raw.version === 'number' && raw.version >= 1 ? raw : upgradeFromStub(raw);

  const current = normalizeItem(source.current);
  const queue: WatchPartyItem[] = [];
  const itemIds = new Set(current ? [current.id] : []);
  for (const entry of Array.isArray(source.queue) ? source.queue : []) {
    const item = normalizeItem(entry);
    if (!item || itemIds.has(item.id) || queue.length >= QUEUE_MAX) continue;
    itemIds.add(item.id);
    queue.push(item);
  }

  const viewers: WatchPartyViewer[] = [];
  const viewerIds = new Set<string>();
  for (const entry of Array.isArray(source.viewers) ? source.viewers : []) {
    const viewer = normalizeViewer(entry);
    // One slot over the join limit: a moderator who takes over a full party is listed too.
    if (!viewer || viewerIds.has(viewer.userId) || viewers.length > VIEWERS_MAX) continue;
    viewerIds.add(viewer.userId);
    viewers.push(viewer);
  }

  const rawPlayback = isRecord(source.playback) ? source.playback : {};
  const playback: WatchPartyPlayback = {
    // Nothing on screen cannot be playing.
    status: current && rawPlayback.status === 'playing' ? 'playing' : 'paused',
    positionSec: clampPosition(rawPlayback.positionSec),
    updatedAt: timestamp(rawPlayback.updatedAt),
  };

  // Item ids must never repeat, even if the counter was damaged.
  const highestSeq = Math.max(0, ...[current, ...queue].filter((i): i is WatchPartyItem => i !== null).map(itemSeq));
  const storedSeq =
    typeof source.nextItemSeq === 'number' &&
    Number.isInteger(source.nextItemSeq) &&
    source.nextItemSeq <= ITEM_SEQ_MAX
      ? source.nextItemSeq
      : 1;

  return {
    version: WATCH_PARTY_STATE_VERSION,
    hostId: isUserId(source.hostId) ? source.hostId : null,
    hostSince: timestamp(source.hostSince),
    controlMode: source.controlMode === 'everyone' ? 'everyone' : 'host',
    current,
    playback,
    queue,
    viewers,
    nextItemSeq: Math.max(1, storedSeq, highestSeq + 1),
    stampedAt: timestamp(source.stampedAt),
  };
}
