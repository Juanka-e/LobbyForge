/**
 * The sync model, as pure functions (the panel is thin glue around them).
 *
 * 1. THE SHARED TIMELINE. The server stores one playback record:
 *    `{ status, positionSec, updatedAt }`, stamped with the server clock.
 *    Where the video "should" be for everyone is
 *
 *        expected = positionSec + (serverNow − updatedAt)   while playing
 *        expected = positionSec                             while paused
 *
 * 2. SERVER TIME ON A CLIENT. `serverNow = Date.now() + offset`. A client
 *    clock can be off by seconds (or minutes), so the offset is measured,
 *    not assumed: every change the server makes carries `stampedAt` (its
 *    clock at the time), and when a change ARRIVES the client knows the
 *    server's clock was at least `stampedAt` — the message took some time
 *    to arrive, never negative time. So `stampedAt − localReceiveTime` is a
 *    lower bound of the offset, and the largest recent bound is the best
 *    estimate (it is off by the quickest delivery, a few ms over WebSocket).
 *    The first state a panel sees is NOT a sample: it may be minutes old.
 *
 * 3. CORRECTION. Each client compares its own player with `expected` and
 *    seeks when they differ by more than DRIFT_TOLERANCE_SEC; it plays or
 *    pauses to match the room. Nothing here dispatches an action — drift
 *    is fixed locally, the server is only told about readiness.
 */

import {
  DRIFT_TOLERANCE_SEC,
  HOST_HEARTBEAT_MS,
  STATUS_DEBOUNCE_MS,
  STATUS_MIN_INTERVAL_MS,
  VIEWER_HEARTBEAT_MS,
} from './constants';
import { PLAYER_STATE } from './player-protocol';
import { isViewerAway } from './reducer';
import type { WatchPartyPlayback, WatchPartyState, WatchPartyViewerStatus } from './state';

// ---------------------------------------------------------------------------
// 1. The timeline
// ---------------------------------------------------------------------------

/** Where the video should be at `serverNowMs`, capped at the video's length when it is known. */
export function expectedPositionSec(
  playback: WatchPartyPlayback,
  serverNowMs: number,
  durationSec?: number | null
): number {
  let position = playback.positionSec;
  if (playback.status === 'playing') position += Math.max(0, serverNowMs - playback.updatedAt) / 1000;
  if (typeof durationSec === 'number' && durationSec > 0) position = Math.min(position, durationSec);
  return Math.max(0, position);
}

// ---------------------------------------------------------------------------
// 2. Clock offset
// ---------------------------------------------------------------------------

export interface ClockSample {
  /** `stampedAt − receivedAt`: a lower bound of (server clock − local clock), in ms. */
  offsetMs: number;
  /** Local ms when the sample was taken. */
  at: number;
}

/** How many recent samples are kept, and for how long. Old ones go so a clock change is noticed. */
export const CLOCK_SAMPLES_KEPT = 12;
export const CLOCK_SAMPLE_MAX_AGE_MS = 10 * 60_000;
/** A "sample" claiming the clocks differ by more than a day is corrupt, not a sample. */
const CLOCK_SAMPLE_SANITY_MS = 24 * 60 * 60_000;

export function clockSample(stampedAtServerMs: number, receivedAtLocalMs: number): ClockSample | null {
  if (!Number.isFinite(stampedAtServerMs) || stampedAtServerMs <= 0) return null;
  const offsetMs = stampedAtServerMs - receivedAtLocalMs;
  if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > CLOCK_SAMPLE_SANITY_MS) return null;
  return { offsetMs, at: receivedAtLocalMs };
}

export function addClockSample(samples: readonly ClockSample[], sample: ClockSample | null, nowMs: number): ClockSample[] {
  const fresh = samples.filter((s) => nowMs - s.at <= CLOCK_SAMPLE_MAX_AGE_MS);
  if (sample) fresh.push(sample);
  return fresh.slice(-CLOCK_SAMPLES_KEPT);
}

/** Server clock minus local clock, in ms: the largest lower bound seen recently, 0 without one. */
export function estimateClockOffset(samples: readonly ClockSample[]): number {
  if (samples.length === 0) return 0;
  return Math.max(...samples.map((s) => s.offsetMs));
}

// ---------------------------------------------------------------------------
// 3. Correcting a player
// ---------------------------------------------------------------------------

export type Correction =
  | { kind: 'none' }
  | { kind: 'seek'; to: number }
  | { kind: 'play'; seekTo: number | null }
  | { kind: 'pause'; seekTo: number | null };

export interface CorrectionInput {
  roomStatus: WatchPartyPlayback['status'];
  expected: number;
  /** The player's YT state code, null before it reported one. */
  playerState: number | null;
  /** The player's position now, null when unknown. */
  localTime: number | null;
  durationSec: number | null;
  tolerance?: number;
}

/**
 * What to tell the player so it matches the room. Pure: cooldowns and the
 * viewer's own choices (not joined yet, paused on purpose) are the
 * caller's business.
 */
export function planCorrection(input: CorrectionInput): Correction {
  const { roomStatus, expected, playerState, localTime, durationSec } = input;
  const tolerance = input.tolerance ?? DRIFT_TOLERANCE_SEC;
  if (playerState === null) return { kind: 'none' };
  const drifted = localTime === null || Math.abs(localTime - expected) > tolerance;

  if (roomStatus === 'playing') {
    switch (playerState) {
      case PLAYER_STATE.PLAYING:
      case PLAYER_STATE.BUFFERING:
        return drifted ? { kind: 'seek', to: expected } : { kind: 'none' };
      case PLAYER_STATE.ENDED:
        // Finished early (it was ahead, or the room seeked back): rejoin.
        // At the real end, wait for the host's player to move the room on.
        if (durationSec !== null && expected < durationSec - 1) return { kind: 'play', seekTo: expected };
        return { kind: 'none' };
      default:
        // Paused, cued or not started yet.
        return { kind: 'play', seekTo: drifted ? expected : null };
    }
  }

  switch (playerState) {
    case PLAYER_STATE.PLAYING:
    case PLAYER_STATE.BUFFERING:
      return { kind: 'pause', seekTo: drifted ? expected : null };
    case PLAYER_STATE.PAUSED:
      // Seeking a PAUSED player keeps it paused.
      return drifted ? { kind: 'seek', to: expected } : { kind: 'none' };
    default:
      // Cued / not started / ended: YouTube STARTS playback when such a
      // player is seeked, so leave it alone until the room plays.
      return { kind: 'none' };
  }
}

// ---------------------------------------------------------------------------
// 4. Readiness — what this viewer tells the room, and when
// ---------------------------------------------------------------------------

export interface ViewerStatusInput {
  hasVideo: boolean;
  connected: boolean;
  engaged: boolean;
  blocked: boolean;
  hold: boolean;
  error: number | null;
  playerState: number | null;
  roomStatus: WatchPartyPlayback['status'];
}

/** The viewer's readiness, or null when there is nothing to be ready for (no video). */
export function desiredViewerStatus(input: ViewerStatusInput): WatchPartyViewerStatus | null {
  if (!input.hasVideo) return null;
  if (input.error !== null || !input.engaged || input.blocked || input.hold) return 'idle';
  if (!input.connected || input.playerState === null) return 'buffering';
  if (input.playerState === PLAYER_STATE.BUFFERING) return 'buffering';
  if (
    input.roomStatus === 'playing' &&
    input.playerState !== PLAYER_STATE.PLAYING &&
    input.playerState !== PLAYER_STATE.ENDED
  ) {
    return 'buffering'; // still starting up
  }
  return 'ready';
}

export interface ReportInput {
  /** What this viewer's player says now (null: nothing to report). */
  desired: WatchPartyViewerStatus | null;
  /** What the room currently shows for this viewer (undefined: not listed). */
  serverStatus: WatchPartyViewerStatus | undefined;
  /** Local ms since `desired` has held its current value. */
  desiredSince: number;
  /** Local ms of this panel's last report or join (0: never). */
  lastSentAt: number;
  now: number;
  isHost: boolean;
  /** False when the list is full and this viewer is not on it: reports would be ignored. */
  canBeListed: boolean;
}

export type ReportDecision =
  | { send: true; status: WatchPartyViewerStatus }
  | { send: false; retryAt: number | null };

/**
 * Report on CHANGE only — after the new status has held for
 * STATUS_DEBOUNCE_MS (a two-second buffering blip is not news), never more
 * often than STATUS_MIN_INTERVAL_MS — plus a heartbeat so a quiet viewer
 * is not taken for gone (every minute for the host, whose absence blocks
 * the room; every five for everyone else).
 */
export function statusReportDecision(input: ReportInput): ReportDecision {
  const { desired, serverStatus, desiredSince, lastSentAt, now } = input;
  if (!input.canBeListed) return { send: false, retryAt: null };
  if (desired !== null && desired !== serverStatus) {
    const earliest = Math.max(desiredSince + STATUS_DEBOUNCE_MS, lastSentAt + STATUS_MIN_INTERVAL_MS);
    return now >= earliest ? { send: true, status: desired } : { send: false, retryAt: earliest };
  }
  if (serverStatus === undefined) return { send: false, retryAt: null };
  const due = lastSentAt + (input.isHost ? HOST_HEARTBEAT_MS : VIEWER_HEARTBEAT_MS);
  return now >= due ? { send: true, status: serverStatus } : { send: false, retryAt: due };
}

// ---------------------------------------------------------------------------
// 5. The room at a glance
// ---------------------------------------------------------------------------

export type RoomSummary =
  | { kind: 'empty' }
  | { kind: 'paused' }
  | { kind: 'synced' }
  | { kind: 'buffering'; count: number }
  | { kind: 'playing' };

/** The header pill: is everyone (who is actually here) watching together? */
export function roomSummary(state: WatchPartyState, serverNowMs: number): RoomSummary {
  if (!state.current) return { kind: 'empty' };
  if (state.playback.status === 'paused') return { kind: 'paused' };
  const present = state.viewers.filter((viewer) => !isViewerAway(viewer, serverNowMs));
  const buffering = present.filter((viewer) => viewer.status === 'buffering').length;
  if (buffering > 0) return { kind: 'buffering', count: buffering };
  if (present.length > 0 && present.every((viewer) => viewer.status === 'ready')) return { kind: 'synced' };
  return { kind: 'playing' };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** `0:07`, `12:48`, `1:02:03`. */
export function formatTime(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
