import { describe, expect, it } from 'vitest';
import {
  AUTOPLAY_BLOCK_MS,
  LOCAL_COMMAND_QUIET_MS,
  PLAYER_CONNECT_TIMEOUT_MS,
  PLAY_RETRY_MS,
  SEEK_COOLDOWN_MS,
  SyncController,
  type SyncRoom,
} from '../controller';
import { PLAYER_STATE, type PlayerInfoUpdate } from '../player-protocol';

const LOCAL_T0 = 1_700_000_000_000;
const VIDEO = 'aaaaaaaaaaa';

type Sent = Array<[string, unknown[]]>;

/** A controller on a fake clock, recording every command it sends. */
function setup(options: { engaged?: boolean } = {}) {
  let now = LOCAL_T0;
  const sent: Sent = [];
  const ended: Array<[string, number | null]> = [];
  const controller = new SyncController({
    now: () => now,
    send: (func, args) => sent.push([func, args]),
    onEnded: (itemId, positionSec) => ended.push([itemId, positionSec]),
    engaged: options.engaged ?? true,
  });
  const base: SyncRoom = {
    itemId: 'v1',
    videoId: VIDEO,
    playback: { status: 'paused', positionSec: 0, updatedAt: LOCAL_T0 },
    offsetMs: 0,
    isHost: false,
  };
  return {
    controller,
    sent,
    ended,
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    room(patch: Partial<SyncRoom>) {
      controller.setRoom({ ...base, ...patch });
    },
    /** The room playing from `positionSec`, started `agoMs` before now (server = local clock). */
    playingFrom(positionSec: number, agoMs = 0, patch: Partial<SyncRoom> = {}) {
      controller.setRoom({ ...base, playback: { status: 'playing', positionSec, updatedAt: now - agoMs }, ...patch });
    },
    pausedAt(positionSec: number, patch: Partial<SyncRoom> = {}) {
      controller.setRoom({ ...base, playback: { status: 'paused', positionSec, updatedAt: now }, ...patch });
    },
    player(info: PlayerInfoUpdate) {
      controller.onMessage({ kind: 'info', initial: false, info: { videoId: VIDEO, currentTimeLastUpdated: now / 1000, ...info } });
    },
    take(): Sent {
      return sent.splice(0, sent.length);
    },
  };
}

describe('SyncController', () => {
  it('waits for the player to answer, and says so if it never does', () => {
    const s = setup();
    s.playingFrom(0);
    s.controller.tick();
    expect(s.take()).toEqual([]);
    expect(s.controller.getView()).toMatchObject({ connected: false, stalled: false, status: 'buffering' });
    s.advance(PLAYER_CONNECT_TIMEOUT_MS + 1);
    s.controller.tick();
    expect(s.controller.getView().stalled).toBe(true);
  });

  it('starts a cued player when the room plays, at the room’s position', () => {
    const s = setup();
    s.playingFrom(30, 10_000); // started 10 s ago at 30 s → 40 s now
    s.player({ playerState: PLAYER_STATE.CUED, currentTime: 0 });
    s.controller.tick();
    expect(s.take()).toEqual([
      ['seekTo', [40, true]],
      ['playVideo', []],
    ]);
  });

  it('spaces its commands out while the player catches up', () => {
    const s = setup();
    s.playingFrom(30, 10_000);
    s.player({ playerState: PLAYER_STATE.CUED, currentTime: 0 });
    s.controller.tick();
    s.take();
    s.advance(500);
    s.controller.tick();
    expect(s.take()).toEqual([]);
    s.advance(Math.max(PLAY_RETRY_MS, SEEK_COOLDOWN_MS));
    s.controller.tick();
    expect(s.take().map(([func]) => func)).toEqual(['seekTo', 'playVideo']);
  });

  it('gives up on a play the browser blocked, until the viewer presses play on the video', () => {
    const s = setup();
    s.playingFrom(0);
    s.player({ playerState: PLAYER_STATE.CUED, currentTime: 0 });
    s.controller.tick();
    s.advance(AUTOPLAY_BLOCK_MS + 1);
    s.controller.tick();
    expect(s.controller.getView()).toMatchObject({ blocked: true, status: 'idle' });
    s.take();
    s.advance(PLAY_RETRY_MS * 3);
    s.controller.tick();
    expect(s.take()).toEqual([]);
    // The viewer clicks play inside the player.
    s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 0.2 });
    expect(s.controller.getView().blocked).toBe(false);
  });

  it('corrects drift beyond the tolerance, and only then', () => {
    const s = setup();
    s.playingFrom(100);
    s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 101 });
    s.controller.tick();
    expect(s.take()).toEqual([]);
    expect(s.controller.getView().inSync).toBe(true);
    s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 104 });
    s.controller.tick();
    expect(s.take()).toEqual([['seekTo', [100, true]]]);
    expect(s.controller.getView().inSync).toBe(false);
  });

  it('uses the server clock: a local clock 10 s behind still lands on the right frame', () => {
    const s = setup();
    // The server wrote the record at ITS time, 10 s ahead of this machine,
    // and the record is 5 s old: the room is at 55 s, not 45 s.
    s.controller.setRoom({
      itemId: 'v1',
      videoId: VIDEO,
      playback: { status: 'playing', positionSec: 50, updatedAt: s.now() + 10_000 - 5_000 },
      offsetMs: 10_000,
      isHost: false,
    });
    s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 45 });
    s.controller.tick();
    expect(s.take()).toEqual([['seekTo', [55, true]]]);
  });

  it('pauses a playing player when the room pauses, then holds the frame', () => {
    const s = setup();
    s.pausedAt(50);
    s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 50.3 });
    s.controller.tick();
    expect(s.take()).toEqual([['pauseVideo', []]]);
    s.player({ playerState: PLAYER_STATE.PAUSED, currentTime: 50.4 });
    s.advance(SEEK_COOLDOWN_MS);
    s.controller.tick();
    expect(s.take()).toEqual([]);
    expect(s.controller.getView().hold).toBe(false);
  });

  it('leaves alone a viewer who paused on purpose, until they catch up', () => {
    const s = setup();
    s.playingFrom(10);
    s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 10 });
    s.advance(5_000);
    s.player({ playerState: PLAYER_STATE.PAUSED, currentTime: 15 });
    expect(s.controller.getView()).toMatchObject({ hold: true, status: 'idle' });
    s.advance(PLAY_RETRY_MS);
    s.controller.tick();
    expect(s.take()).toEqual([]);
    s.controller.engage(); // "Catch up"
    expect(s.controller.getView().hold).toBe(false);
    expect(s.take().map(([func]) => func)).toContain('playVideo');
  });

  it('does not mistake its own pause for the viewer’s', () => {
    const s = setup();
    s.playingFrom(10);
    s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 10 });
    s.controller.localPause();
    s.player({ playerState: PLAYER_STATE.PAUSED, currentTime: 10 });
    expect(s.controller.getView().hold).toBe(false);
  });

  it('forgets a hold once the room itself pauses', () => {
    const s = setup();
    s.playingFrom(10);
    s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 10 });
    s.advance(3_000);
    s.player({ playerState: PLAYER_STATE.PAUSED, currentTime: 13 });
    expect(s.controller.getView().hold).toBe(true);
    s.pausedAt(13);
    expect(s.controller.getView().hold).toBe(false);
  });

  it('commands nothing before the viewer has joined playback, then starts at once', () => {
    const s = setup({ engaged: false });
    s.playingFrom(20);
    s.player({ playerState: PLAYER_STATE.CUED, currentTime: 0 });
    s.controller.tick();
    expect(s.take()).toEqual([]);
    expect(s.controller.getView()).toMatchObject({ engaged: false, status: 'idle' });
    s.controller.engage(); // "Join playback"
    expect(s.take()).toEqual([
      ['seekTo', [20, true]],
      ['playVideo', []],
    ]);
  });

  it('counts a viewer who pressed play on the video as joined', () => {
    const s = setup({ engaged: false });
    s.playingFrom(0);
    s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 0 });
    expect(s.controller.getView().engaged).toBe(true);
  });

  it('after a local control, waits for the room instead of undoing it', () => {
    const s = setup();
    s.pausedAt(30);
    s.player({ playerState: PLAYER_STATE.PAUSED, currentTime: 30 });
    s.controller.localPlay();
    expect(s.take()).toEqual([['playVideo', []]]);
    // The player starts before the new record arrives: the old (paused)
    // record must not pause it again.
    s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 30.1 });
    s.advance(500);
    s.controller.tick();
    expect(s.take()).toEqual([]);
    // The record arrives; corrections resume and there is nothing to do.
    s.playingFrom(30, 500);
    s.controller.tick();
    expect(s.take()).toEqual([]);
  });

  it('gives up waiting for the room after a while (the action failed)', () => {
    const s = setup();
    s.pausedAt(30);
    s.player({ playerState: PLAYER_STATE.PAUSED, currentTime: 30 });
    s.controller.localPlay();
    s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 30 });
    s.take();
    s.advance(LOCAL_COMMAND_QUIET_MS + 1);
    s.controller.tick();
    // Back to the room: paused, and at the room's frame (it had run on ~2 s).
    expect(s.take()).toEqual([
      ['pauseVideo', []],
      ['seekTo', [30, true]],
    ]);
  });

  it('seeks the controller’s own player straight away', () => {
    const s = setup();
    s.controller.localSeek(75);
    expect(s.take()).toEqual([['seekTo', [75, true]]]);
  });

  describe('end of a video', () => {
    it('the host’s player reports it, once', () => {
      const s = setup();
      s.playingFrom(98, 0, { isHost: true });
      s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 98, duration: 100 });
      s.advance(2_500);
      s.player({ playerState: PLAYER_STATE.ENDED, currentTime: 100 });
      expect(s.ended).toEqual([['v1', 100]]);
      s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 99 });
      s.player({ playerState: PLAYER_STATE.ENDED, currentTime: 100 });
      expect(s.ended).toHaveLength(1);
    });

    it('is not reported when the host’s player ended far from where the room is', () => {
      const s = setup();
      s.playingFrom(40, 0, { isHost: true });
      s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 99, duration: 100 });
      s.player({ playerState: PLAYER_STATE.ENDED, currentTime: 100 });
      expect(s.ended).toEqual([]);
    });

    it('is never reported by a viewer — their early end is simply rejoined', () => {
      const s = setup();
      s.playingFrom(50);
      s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 99, duration: 100 });
      s.player({ playerState: PLAYER_STATE.ENDED, currentTime: 100 });
      expect(s.ended).toEqual([]);
      s.controller.tick();
      expect(s.take()).toEqual([
        ['seekTo', [50, true]],
        ['playVideo', []],
      ]);
    });
  });

  it('ignores a player that still shows the previous video', () => {
    const s = setup();
    s.playingFrom(10);
    s.controller.onMessage({ kind: 'info', initial: false, info: { videoId: 'bbbbbbbbbbb', playerState: PLAYER_STATE.CUED, currentTime: 0 } });
    s.controller.tick();
    expect(s.take()).toEqual([]);
    expect(s.controller.currentTime()).toBeNull();
  });

  it('starts over with a new video: a new player, no leftover flags', () => {
    const s = setup();
    s.playingFrom(0);
    s.player({ playerState: PLAYER_STATE.CUED, currentTime: 0 });
    s.controller.tick();
    s.advance(AUTOPLAY_BLOCK_MS + 1);
    s.controller.tick();
    expect(s.controller.getView().blocked).toBe(true);
    s.room({ itemId: 'v2', videoId: 'bbbbbbbbbbb', playback: { status: 'playing', positionSec: 0, updatedAt: s.now() } });
    expect(s.controller.getView()).toMatchObject({ connected: false, blocked: false, hold: false, engaged: true });
  });

  it('stops correcting a player that shows an error', () => {
    const s = setup();
    s.playingFrom(10);
    s.player({ playerState: PLAYER_STATE.CUED, currentTime: 0 });
    s.controller.onMessage({ kind: 'error', code: 150 });
    s.controller.tick();
    expect(s.take()).toEqual([]);
    expect(s.controller.getView()).toMatchObject({ error: 150, status: 'idle' });
  });

  it('tells subscribers only when the view changes', () => {
    const s = setup();
    let calls = 0;
    const unsubscribe = s.controller.subscribe(() => {
      calls += 1;
    });
    s.pausedAt(0);
    const before = calls;
    s.controller.tick();
    s.controller.tick();
    expect(calls).toBe(before);
    s.player({ playerState: PLAYER_STATE.PAUSED, currentTime: 0 });
    expect(calls).toBe(before + 1);
    unsubscribe();
    s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 0 });
    expect(calls).toBe(before + 1);
  });

  it('reports where the room is and where its player is', () => {
    const s = setup();
    s.playingFrom(10, 2_000);
    s.player({ playerState: PLAYER_STATE.PLAYING, currentTime: 12, duration: 300 });
    expect(s.controller.expectedTime()).toBe(12);
    expect(s.controller.currentTime()).toBe(12);
    expect(s.controller.duration()).toBe(300);
  });
});
