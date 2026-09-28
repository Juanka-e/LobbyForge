import { describe, expect, it } from 'vitest';
import {
  EMPTY_PLAYER,
  PLAYER_STATE,
  applyPlayerMessage,
  commandMessage,
  listeningMessage,
  parsePlayerMessage,
  playerErrorKind,
  playerTimeAt,
  type PlayerSnapshot,
} from '../player-protocol';

const NOW = 1_700_000_000_000;

describe('messages to the player', () => {
  it('speaks the widget protocol YouTube’s own iframe_api uses', () => {
    expect(JSON.parse(listeningMessage(7))).toEqual({ event: 'listening', id: 7, channel: 'widget' });
    expect(JSON.parse(commandMessage('seekTo', [42.5, true], 7))).toEqual({
      event: 'command',
      func: 'seekTo',
      args: [42.5, true],
      id: 7,
      channel: 'widget',
    });
    expect(JSON.parse(commandMessage('playVideo', [], 7)).args).toEqual([]);
  });
});

describe('parsePlayerMessage — untrusted input', () => {
  it('reads an info delivery, keeping only well-typed fields', () => {
    const message = parsePlayerMessage(
      JSON.stringify({
        event: 'infoDelivery',
        id: 7,
        channel: 'widget',
        info: {
          playerState: 1,
          currentTime: 61.2,
          currentTimeLastUpdated_: NOW / 1000,
          duration: 212,
          playbackRate: 1,
          videoData: { video_id: 'aaaaaaaaaaa', title: 'A film' },
          extra: { nested: true },
        },
      })
    );
    expect(message).toEqual({
      kind: 'info',
      initial: false,
      info: {
        playerState: 1,
        currentTime: 61.2,
        currentTimeLastUpdated: NOW / 1000,
        duration: 212,
        playbackRate: 1,
        videoId: 'aaaaaaaaaaa',
        title: 'A film',
      },
    });
  });

  it('marks the initial delivery', () => {
    expect(parsePlayerMessage(JSON.stringify({ event: 'initialDelivery', info: { playerState: 5 } }))).toEqual({
      kind: 'info',
      initial: true,
      info: { playerState: 5 },
    });
  });

  it('drops fields of the wrong type or out of range', () => {
    const message = parsePlayerMessage({
      event: 'infoDelivery',
      info: {
        playerState: 42,
        currentTime: -1,
        duration: 'long',
        playbackRate: 99,
        videoData: { video_id: '<script>', title: 7 },
      },
    });
    expect(message).toEqual({ kind: 'info', initial: false, info: {} });
  });

  it('caps an absurdly long title', () => {
    const message = parsePlayerMessage({ event: 'infoDelivery', info: { videoData: { title: 'x'.repeat(1000) } } });
    expect(message?.kind === 'info' && message.info.title?.length).toBe(300);
  });

  it('reads state changes, errors, readiness and the handshake', () => {
    expect(parsePlayerMessage('{"event":"onStateChange","info":2}')).toEqual({ kind: 'state', state: PLAYER_STATE.PAUSED });
    expect(parsePlayerMessage('{"event":"onStateChange","info":9}')).toEqual({ kind: 'other' });
    expect(parsePlayerMessage('{"event":"onError","info":150}')).toEqual({ kind: 'error', code: 150 });
    expect(parsePlayerMessage('{"event":"onError","info":"bad"}')).toEqual({ kind: 'other' });
    expect(parsePlayerMessage('{"event":"onReady","info":null}')).toEqual({ kind: 'ready' });
    expect(parsePlayerMessage('{"event":"readyToListen"}')).toEqual({ kind: 'listen-again' });
    expect(parsePlayerMessage('{"event":"alreadyInitialized"}')).toEqual({ kind: 'other' });
    expect(parsePlayerMessage('{"event":"infoDelivery","info":"nope"}')).toEqual({ kind: 'other' });
  });

  it.each([
    ['not JSON', 'hello'],
    ['JSON without an event', '{"info":1}'],
    ['an array', '[1,2]'],
    ['a number', 5],
    ['null', null],
    ['a huge string', `{"event":"x","pad":"${'a'.repeat(200_000)}"}`],
  ])('ignores %s', (_label, data) => {
    expect(parsePlayerMessage(data)).toBeNull();
  });
});

describe('applyPlayerMessage and playerTimeAt', () => {
  const info = (fields: Record<string, unknown>) => parsePlayerMessage({ event: 'infoDelivery', info: fields })!;

  it('marks the player connected on any message', () => {
    const next = applyPlayerMessage(EMPTY_PLAYER, { kind: 'other' }, NOW);
    expect(next.connected).toBe(true);
  });

  it('returns the same object when nothing changed', () => {
    const once = applyPlayerMessage(EMPTY_PLAYER, info({ playerState: 2, duration: 100 }), NOW);
    expect(applyPlayerMessage(once, info({ playerState: 2, duration: 100 }), NOW + 10)).toBe(once);
  });

  it('keeps time as the player measured it, or as it arrived when that looks wrong', () => {
    const measured = applyPlayerMessage(EMPTY_PLAYER, info({ currentTime: 10, currentTimeLastUpdated_: (NOW - 200) / 1000 }), NOW);
    expect(measured.measuredAt).toBeCloseTo(NOW - 200, 0);
    const implausible = applyPlayerMessage(EMPTY_PLAYER, info({ currentTime: 10, currentTimeLastUpdated_: (NOW - 60_000) / 1000 }), NOW);
    expect(implausible.measuredAt).toBe(NOW);
  });

  it('moves a playing player’s time on, a little at most; a paused one stays put', () => {
    const playing: PlayerSnapshot = { ...EMPTY_PLAYER, connected: true, state: PLAYER_STATE.PLAYING, currentTime: 10, measuredAt: NOW };
    expect(playerTimeAt(playing, NOW + 500)).toBe(10.5);
    expect(playerTimeAt({ ...playing, rate: 2 }, NOW + 500)).toBe(11);
    expect(playerTimeAt(playing, NOW + 60_000)).toBe(12);
    expect(playerTimeAt({ ...playing, state: PLAYER_STATE.PAUSED }, NOW + 60_000)).toBe(10);
    expect(playerTimeAt(EMPTY_PLAYER, NOW)).toBeNull();
  });

  it('records errors and clears them once the player plays again', () => {
    const failed = applyPlayerMessage(EMPTY_PLAYER, { kind: 'error', code: 100 }, NOW);
    expect(failed.error).toBe(100);
    expect(applyPlayerMessage(failed, { kind: 'state', state: PLAYER_STATE.PLAYING }, NOW).error).toBeNull();
    expect(applyPlayerMessage(failed, info({ playerState: PLAYER_STATE.PLAYING }), NOW).error).toBeNull();
  });

  it('learns which video the player shows and its title', () => {
    const next = applyPlayerMessage(EMPTY_PLAYER, info({ videoData: { video_id: 'aaaaaaaaaaa', title: 'Clip' } }), NOW);
    expect(next.videoId).toBe('aaaaaaaaaaa');
    expect(next.title).toBe('Clip');
  });

  it('ignores a zero duration (YouTube reports 0 before it knows)', () => {
    const known = applyPlayerMessage(EMPTY_PLAYER, info({ duration: 212 }), NOW);
    expect(applyPlayerMessage(known, info({ duration: 0 }), NOW).duration).toBe(212);
  });
});

describe('playerErrorKind', () => {
  it('groups YouTube’s error codes by what the viewer can do', () => {
    expect(playerErrorKind(101)).toBe('notEmbeddable');
    expect(playerErrorKind(150)).toBe('notEmbeddable');
    expect(playerErrorKind(100)).toBe('notFound');
    expect(playerErrorKind(2)).toBe('badLink');
    expect(playerErrorKind(5)).toBe('failed');
    expect(playerErrorKind(153)).toBe('failed');
  });
});
