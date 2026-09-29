/**
 * SyncController — keeps ONE viewer's YouTube player on the shared
 * timeline. No React and no DOM: the panel feeds it the room (on every
 * render), the player's messages (as they arrive) and a tick (twice a
 * second); it answers with player commands through `send` and with a
 * view for the panel to draw. Tests drive it with a fake clock.
 *
 * What it adds on top of `planCorrection`:
 *
 *  - ENGAGEMENT. Browsers refuse to start a video with sound until the
 *    person has interacted with the page. Until they have (the panel
 *    starts engaged when `navigator.userActivation.hasBeenActive`), the
 *    player is left alone and the panel shows "Click to join playback".
 *  - BLOCKED AUTOPLAY. If a play command has not got the player going
 *    within AUTOPLAY_BLOCK_MS, the browser (or YouTube) refused it: stop
 *    retrying and ask the viewer to press play on the video itself.
 *  - HOLD. A viewer who pauses their own player while the room plays did
 *    it on purpose — it is not dragged back. The panel offers "Resume".
 *  - COOLDOWNS. A seek takes a moment to land; commands are spaced so a
 *    slow connection is not seeked over and over.
 *  - QUIET AFTER OWN COMMANDS. When this viewer controls the room, their
 *    player follows the button at once; corrections pause until the new
 *    playback record arrives (or LOCAL_COMMAND_QUIET_MS pass), so the old
 *    record does not drag it back in between.
 *  - END OF VIDEO. The HOST's player reports the end, so the room moves on
 *    to the next video once — not once per viewer.
 */

import { DRIFT_TOLERANCE_SEC } from './constants';
import {
  EMPTY_PLAYER,
  PLAYER_STATE,
  applyPlayerMessage,
  playerTimeAt,
  type PlayerCommand,
  type PlayerMessage,
  type PlayerSnapshot,
} from './player-protocol';
import type { WatchPartyPlayback, WatchPartyViewerStatus } from './state';
import { desiredViewerStatus, expectedPositionSec, planCorrection } from './sync';

/** A play command that has not started the player by then was blocked. */
export const AUTOPLAY_BLOCK_MS = 4_000;
/** No answer from the player this long after it was put up: say so. */
export const PLAYER_CONNECT_TIMEOUT_MS = 15_000;
/** Spacing between corrective seeks, and between play/pause retries. */
export const SEEK_COOLDOWN_MS = 3_000;
export const PLAY_RETRY_MS = 3_000;
export const PAUSE_RETRY_MS = 2_000;
/** A pause within this long of our own pause command is ours, not the viewer's. */
export const OWN_COMMAND_GRACE_MS = 1_500;
/** After a local control, corrections wait this long for the room to catch up. */
export const LOCAL_COMMAND_QUIET_MS = 2_500;

export interface SyncRoom {
  itemId: string | null;
  videoId: string | null;
  playback: WatchPartyPlayback;
  /** Server clock minus local clock (ms). */
  offsetMs: number;
  isHost: boolean;
}

export interface SyncView {
  connected: boolean;
  /** The player never answered: likely blocked by the network or an extension. */
  stalled: boolean;
  playerState: number | null;
  /** Whole seconds, for display. */
  localTime: number | null;
  duration: number | null;
  title: string | null;
  error: number | null;
  engaged: boolean;
  blocked: boolean;
  hold: boolean;
  /** This viewer is playing along within the tolerance. */
  inSync: boolean;
  /** What this viewer's readiness is (null: no video to be ready for). */
  status: WatchPartyViewerStatus | null;
}

export interface SyncControllerOptions {
  now: () => number;
  send: (func: PlayerCommand, args: unknown[]) => void;
  /** The host's player reached the end of `itemId`. */
  onEnded?: (itemId: string, positionSec: number | null) => void;
  /** Start engaged (the page already had a user gesture). */
  engaged?: boolean;
}

const PAUSED_AT_ZERO: WatchPartyPlayback = { status: 'paused', positionSec: 0, updatedAt: 0 };

export class SyncController {
  private readonly now: () => number;
  private readonly send: (func: PlayerCommand, args: unknown[]) => void;
  private readonly onEnded?: (itemId: string, positionSec: number | null) => void;

  private room: SyncRoom = { itemId: null, videoId: null, playback: PAUSED_AT_ZERO, offsetMs: 0, isHost: false };
  private player: PlayerSnapshot = EMPTY_PLAYER;
  private engaged: boolean;
  private blocked = false;
  private hold = false;
  private attachedAt: number;
  private playRequestedAt: number | null = null;
  private lastSeekAt = Number.NEGATIVE_INFINITY;
  private lastPlayAt = Number.NEGATIVE_INFINITY;
  private lastPauseAt = Number.NEGATIVE_INFINITY;
  private quietUntil = 0;
  private endedReported: string | null = null;
  private view: SyncView;
  private readonly listeners = new Set<() => void>();

  constructor(options: SyncControllerOptions) {
    this.now = options.now;
    this.send = options.send;
    this.onEnded = options.onEnded;
    this.engaged = options.engaged ?? false;
    this.attachedAt = this.now();
    this.view = this.computeView();
  }

  // -- inputs ---------------------------------------------------------------

  /** The room as the latest state has it. Cheap; call it on every render. */
  setRoom(room: SyncRoom): void {
    const previous = this.room;
    this.room = room;
    if (room.itemId !== previous.itemId) {
      // A new video means a new player.
      this.player = EMPTY_PLAYER;
      this.blocked = false;
      this.hold = false;
      this.playRequestedAt = null;
      this.attachedAt = this.now();
      this.lastSeekAt = this.lastPlayAt = this.lastPauseAt = Number.NEGATIVE_INFINITY;
      this.quietUntil = 0;
    } else if (
      room.playback.updatedAt !== previous.playback.updatedAt ||
      room.playback.status !== previous.playback.status ||
      room.playback.positionSec !== previous.playback.positionSec
    ) {
      // The room moved: whatever we were waiting for has arrived.
      this.quietUntil = 0;
      if (room.playback.status === 'paused') this.hold = false;
    }
    this.publish();
  }

  onMessage(message: PlayerMessage): void {
    const now = this.now();
    const previousState = this.player.state;
    this.player = applyPlayerMessage(this.player, message, now);
    if (this.player.state !== previousState) this.onStateChange(previousState, this.player.state, now);
    this.publish();
  }

  /** "Click to join playback", "Resume" and "Resync": the viewer wants to be in sync now. */
  engage(): void {
    this.engaged = true;
    this.blocked = false;
    this.hold = false;
    this.playRequestedAt = null;
    this.lastSeekAt = this.lastPlayAt = this.lastPauseAt = Number.NEGATIVE_INFINITY;
    this.quietUntil = 0;
    this.tick();
  }

  /** This viewer pressed play for everyone: their own player goes first. */
  localPlay(): void {
    const now = this.now();
    this.engaged = true;
    this.blocked = false;
    this.hold = false;
    this.send('playVideo', []);
    this.lastPlayAt = now;
    this.playRequestedAt = now;
    this.quietUntil = now + LOCAL_COMMAND_QUIET_MS;
    this.publish();
  }

  localPause(): void {
    const now = this.now();
    this.hold = false;
    this.send('pauseVideo', []);
    this.lastPauseAt = now;
    this.quietUntil = now + LOCAL_COMMAND_QUIET_MS;
    this.publish();
  }

  localSeek(toSec: number): void {
    const now = this.now();
    this.send('seekTo', [toSec, true]);
    this.lastSeekAt = now;
    this.quietUntil = now + LOCAL_COMMAND_QUIET_MS;
    this.publish();
  }

  /** This viewer just moved the room to where their player already is: hold still until it arrives. */
  expectRoomChange(): void {
    this.quietUntil = this.now() + LOCAL_COMMAND_QUIET_MS;
  }

  /** The player's position right now (precise — for "sync everyone to me"). */
  currentTime(): number | null {
    if (!this.playerMatchesRoom()) return null;
    return playerTimeAt(this.player, this.now());
  }

  /** Where the room's timeline is right now, on this machine's estimate of server time. */
  expectedTime(): number {
    return expectedPositionSec(this.room.playback, this.now() + this.room.offsetMs, this.player.duration);
  }

  duration(): number | null {
    return this.player.duration;
  }

  // -- the loop ---------------------------------------------------------------

  tick(): void {
    const now = this.now();
    const { playback, itemId } = this.room;
    if (!itemId || !this.player.connected || !this.playerMatchesRoom() || this.player.error !== null) {
      this.publish();
      return;
    }
    const state = this.player.state;

    // A play command that never got the player going was refused.
    if (
      playback.status === 'playing' &&
      this.playRequestedAt !== null &&
      !this.blocked &&
      state !== PLAYER_STATE.PLAYING &&
      state !== PLAYER_STATE.BUFFERING &&
      now - this.playRequestedAt > AUTOPLAY_BLOCK_MS
    ) {
      this.blocked = true;
    }

    const leaveAlone =
      !this.engaged || this.blocked || now < this.quietUntil || (this.hold && playback.status === 'playing');
    if (!leaveAlone) {
      const correction = planCorrection({
        roomStatus: playback.status,
        expected: this.expectedTime(),
        playerState: state,
        localTime: playerTimeAt(this.player, now),
        durationSec: this.player.duration,
      });
      switch (correction.kind) {
        case 'seek':
          if (now - this.lastSeekAt >= SEEK_COOLDOWN_MS) {
            this.send('seekTo', [correction.to, true]);
            this.lastSeekAt = now;
          }
          break;
        case 'play':
          if (now - this.lastPlayAt >= PLAY_RETRY_MS) {
            if (correction.seekTo !== null && now - this.lastSeekAt >= SEEK_COOLDOWN_MS) {
              this.send('seekTo', [correction.seekTo, true]);
              this.lastSeekAt = now;
            }
            this.send('playVideo', []);
            this.lastPlayAt = now;
            this.playRequestedAt ??= now;
          }
          break;
        case 'pause':
          if (now - this.lastPauseAt >= PAUSE_RETRY_MS) {
            this.send('pauseVideo', []);
            this.lastPauseAt = now;
            if (correction.seekTo !== null && now - this.lastSeekAt >= SEEK_COOLDOWN_MS) {
              this.send('seekTo', [correction.seekTo, true]);
              this.lastSeekAt = now;
            }
          }
          break;
        default:
          break;
      }
    }
    this.publish();
  }

  // -- output -------------------------------------------------------------------

  getView = (): SyncView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // -- internals ----------------------------------------------------------------

  /** Messages from a player still showing the previous video are not about this one. */
  private playerMatchesRoom(): boolean {
    return this.player.videoId === null || this.player.videoId === this.room.videoId;
  }

  private onStateChange(previous: number | null, state: number | null, now: number): void {
    const roomPlaying = this.room.playback.status === 'playing';
    if (state === PLAYER_STATE.PLAYING) {
      // Playing — whether we asked or the viewer pressed play on the video.
      this.engaged = true;
      this.blocked = false;
      this.hold = false;
      this.playRequestedAt = null;
    }
    if (
      state === PLAYER_STATE.PAUSED &&
      (previous === PLAYER_STATE.PLAYING || previous === PLAYER_STATE.BUFFERING) &&
      roomPlaying &&
      this.engaged &&
      now - this.lastPauseAt > OWN_COMMAND_GRACE_MS &&
      now >= this.quietUntil
    ) {
      this.hold = true;
    }
    if (state === PLAYER_STATE.ENDED && this.room.isHost && roomPlaying && this.room.itemId) {
      const itemId = this.room.itemId;
      const duration = this.player.duration;
      // Uncapped: has the ROOM's timeline really reached the end too?
      const roomAt = expectedPositionSec(this.room.playback, now + this.room.offsetMs);
      if (this.endedReported !== itemId && (duration === null || roomAt >= duration - 3)) {
        this.endedReported = itemId;
        this.onEnded?.(itemId, duration ?? playerTimeAt(this.player, now));
      }
    }
  }

  private computeView(): SyncView {
    const now = this.now();
    const matches = this.playerMatchesRoom();
    const player = matches ? this.player : EMPTY_PLAYER;
    const localTime = playerTimeAt(player, now);
    const roomStatus = this.room.playback.status;
    const hasVideo = this.room.itemId !== null;
    const drift =
      localTime === null ? null : Math.abs(localTime - expectedPositionSec(this.room.playback, now + this.room.offsetMs, player.duration));
    const inSync =
      hasVideo &&
      this.engaged &&
      !this.blocked &&
      !this.hold &&
      player.error === null &&
      drift !== null &&
      drift <= DRIFT_TOLERANCE_SEC &&
      (roomStatus === 'playing' ? player.state === PLAYER_STATE.PLAYING : player.state !== PLAYER_STATE.PLAYING);
    return {
      connected: player.connected,
      stalled: hasVideo && !player.connected && now - this.attachedAt > PLAYER_CONNECT_TIMEOUT_MS,
      playerState: player.state,
      localTime: localTime === null ? null : Math.floor(localTime),
      duration: player.duration,
      title: player.title,
      error: player.error,
      engaged: this.engaged,
      blocked: this.blocked,
      hold: this.hold,
      inSync,
      status: desiredViewerStatus({
        hasVideo,
        connected: player.connected,
        engaged: this.engaged,
        blocked: this.blocked,
        hold: this.hold,
        error: player.error,
        playerState: player.state,
        roomStatus,
      }),
    };
  }

  private publish(): void {
    const next = this.computeView();
    const previous = this.view;
    const same = (Object.keys(next) as Array<keyof SyncView>).every((key) => next[key] === previous[key]);
    if (same) return;
    this.view = next;
    for (const listener of this.listeners) listener();
  }
}
