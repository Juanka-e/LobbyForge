import { describe, expect, it } from 'vitest';
import { DEFAULT_VILLAGE_SETTINGS } from '../state';
import { Game, ids, nightOne, playNightOne, startedGame } from './helpers';

describe('a player leaves mid-game', () => {
  it('counts as dead ("fled"), with their role revealed', () => {
    const g = nightOne(6);
    g.act({ type: 'leave', playerId: 'p6' });
    expect(g.player('p6')).toMatchObject({
      alive: false,
      death: { round: 1, time: 'night', cause: 'fled', role: 'villager' },
    });
    expect(g.state.log.at(-1)).toMatchObject({ kind: 'death', playerId: 'p6', cause: 'fled' });
  });

  it('ends the game when the last vampire walks out', () => {
    const g = nightOne(6);
    g.act({ type: 'leave', playerId: 'p1' });
    expect(g.state.phase).toBe('ended');
    expect(g.state.outcome?.winner).toBe('village');
  });

  it('drops their vote and any vote cast for them, and closes the vote if everyone left has voted', () => {
    const g = nightOne(6);
    playNightOne(g, { victim: 'p6', doctorTarget: 'p2' });
    g.skip();
    g.skip(); // voting, 5 alive
    g.vote('p1', 'p2');
    g.vote('p2', 'p3');
    g.vote('p3', 'p2');
    g.vote('p4', 'p2');
    g.act({ type: 'leave', playerId: 'p2' });
    // p2's own vote is gone and nobody's vote points at them any more,
    // so p1, p3 and p4 must vote again before the vote can close.
    expect(g.state.phase).toBe('voting');
    expect(g.state.votes).toEqual({});
    g.vote('p1', 'p3');
    g.vote('p3', 'p5');
    g.vote('p4', 'p5');
    expect(g.state.phase).toBe('voting');
    g.vote('p5', 'p3');
    expect(g.state.phase).toBe('verdict');
  });

  it('ends the night early if the leaver was the last one the night waited for', () => {
    const g = nightOne(6);
    g.target('p1', 'p6');
    g.target('p2', 'p1');
    g.target('p3', 'p3');
    g.act({ type: 'leave', playerId: 'p4' }); // the undecided survivor
    expect(g.state.phase).toBe('dawn');
  });

  it('lets a dead player or a spectator leave without drama', () => {
    const g = nightOne(6);
    g.act({ type: 'join', playerId: 'watcher', name: 'Watcher' });
    g.act({ type: 'leave', playerId: 'watcher' });
    expect(g.state.spectators).toEqual([]);
    g.act({ type: 'leave', playerId: 'p6' });
    const after = g.state;
    g.act({ type: 'leave', playerId: 'p6' });
    expect(g.state).toBe(after);
  });
});

describe('kick (host)', () => {
  it('removes a player from the lobby', () => {
    const g = new Game();
    g.lobby(ids(3));
    g.act({ type: 'kick', targetId: 'p2' });
    expect(g.state.players.map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  it('takes a living player out of a running game', () => {
    const g = nightOne(6);
    g.act({ type: 'kick', targetId: 'p6' });
    expect(g.player('p6').death).toMatchObject({ cause: 'removed', role: 'villager' });
  });

  it('removes a spectator', () => {
    const g = startedGame(5);
    g.act({ type: 'join', playerId: 'watcher', name: 'Watcher' });
    g.act({ type: 'kick', targetId: 'watcher' });
    expect(g.state.spectators).toEqual([]);
  });
});

describe('end-game and play-again (host)', () => {
  it('ends a running game with no winner and reveals everything', () => {
    const g = nightOne(6);
    g.act({ type: 'end-game' });
    expect(g.state.phase).toBe('ended');
    expect(g.state.outcome).toEqual({ winner: null, reason: 'host-ended', winners: [] });
  });

  it('does nothing from the lobby', () => {
    const g = new Game();
    g.act({ type: 'end-game' });
    expect(g.state.phase).toBe('lobby');
  });

  it('starts a fresh lobby with the same village', () => {
    const g = nightOne(6);
    g.act({ type: 'configure', settings: { daySeconds: 120 } });
    playNightOne(g);
    g.act({ type: 'end-game' });
    g.act({ type: 'play-again' });
    expect(g.state.phase).toBe('lobby');
    expect(g.state.round).toBe(0);
    expect(g.state.players.map((p) => [p.id, p.name, p.ready, p.alive, p.death])).toEqual(
      ids(6).map((id) => [id, g.player(id).name, false, true, null])
    );
    expect(g.state.settings).toEqual({ ...DEFAULT_VILLAGE_SETTINGS, daySeconds: 120 });
    expect(g.state.secret).toEqual({
      roles: {},
      night: {},
      notes: {},
      resources: {},
      packChat: [],
      packSent: {},
      packSeq: 0,
      history: [],
    });
    expect(g.state.log).toEqual([]);
    expect(g.state.outcome).toBeNull();
    expect(g.state.jesterWinners).toEqual([]);
  });

  it('only plays again from the end screen', () => {
    const g = nightOne(6);
    g.act({ type: 'play-again' });
    expect(g.state.phase).toBe('night');
  });
});

describe('garbage in', () => {
  it('never throws, whatever arrives', () => {
    const g = nightOne(6);
    const junk: unknown[] = [
      null,
      undefined,
      42,
      'vote',
      [],
      {},
      { type: 'nope' },
      { type: 'vote' },
      { type: 'join', playerId: 7, name: {} },
      { type: 'night-target', playerId: 'p1', targetId: 12 },
      { type: 'configure', settings: 'fast' },
      { type: 'chat', playerId: 'p1', text: null },
      { type: 'extend', seconds: 'lots' },
      { type: 'advance', phaseId: 'x' },
    ];
    const before = g.state;
    for (const action of junk) expect(() => g.actRaw(action)).not.toThrow();
    expect(g.state).toBe(before);
  });
});
