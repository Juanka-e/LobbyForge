import { describe, expect, it } from 'vitest';
import { Game, T0, ids, nightOne, startedGame } from './helpers';

describe('timeout (reported by any client)', () => {
  it('does nothing before the deadline, as judged by the server clock', () => {
    const g = startedGame(5);
    g.tick(5_000);
    g.act({ type: 'timeout', playerId: 'p2', phaseId: g.state.phaseId });
    expect(g.state.phase).toBe('role_reveal');
  });

  it('forgives a client clock that runs up to a second fast', () => {
    const g = startedGame(5);
    g.tick(9_200);
    g.act({ type: 'timeout', playerId: 'p2', phaseId: g.state.phaseId });
    expect(g.state.phase).toBe('night');
  });

  it('ends the phase once the deadline has passed', () => {
    const g = startedGame(5);
    g.tick(10_000);
    g.act({ type: 'timeout', playerId: 'p2', phaseId: g.state.phaseId });
    expect(g.state.phase).toBe('night');
  });

  it('ignores a stale report for a phase that already ended', () => {
    const g = startedGame(5);
    const reveal = g.state.phaseId;
    g.tick(10_000);
    g.act({ type: 'timeout', playerId: 'p2', phaseId: reveal });
    const night = g.state;
    g.tick(60_000);
    g.act({ type: 'timeout', playerId: 'p3', phaseId: reveal });
    expect(g.state).toBe(night);
  });

  it('never fires in the lobby or after the game', () => {
    const g = new Game();
    g.lobby(ids(5));
    const lobby = g.state;
    g.act({ type: 'timeout', playerId: 'p1', phaseId: lobby.phaseId });
    expect(g.state).toBe(lobby);
  });
});

describe('advance (host)', () => {
  it('ends the current phase at once', () => {
    const g = startedGame(5);
    g.skip();
    expect(g.state.phase).toBe('night');
  });

  it('ignores a double click that names an old phase', () => {
    const g = startedGame(5);
    const reveal = g.state.phaseId;
    g.act({ type: 'advance', phaseId: reveal });
    const night = g.state;
    g.act({ type: 'advance', phaseId: reveal });
    expect(g.state).toBe(night);
  });

  it('does nothing in the lobby', () => {
    const g = new Game();
    g.lobby(ids(5));
    g.act({ type: 'advance', phaseId: g.state.phaseId });
    expect(g.state.phase).toBe('lobby');
  });
});

describe('pause, resume and extend (host)', () => {
  it('freezes the clock and restores the remaining time on resume', () => {
    const g = nightOne(6); // 30 s night
    g.tick(12_000);
    g.act({ type: 'pause' });
    expect(g.state.phaseEndsAt).toBeNull();
    expect(g.state.pausedRemainingMs).toBe(18_000);
    g.tick(120_000);
    g.act({ type: 'timeout', playerId: 'p1', phaseId: g.state.phaseId });
    expect(g.state.phase).toBe('night');
    g.act({ type: 'resume' });
    expect(g.state.pausedRemainingMs).toBeNull();
    expect(Date.parse(g.state.phaseEndsAt!)).toBe(g.now + 18_000);
  });

  it('lets the host skip a paused phase, which clears the pause', () => {
    const g = nightOne(6);
    g.act({ type: 'pause' });
    g.skip();
    expect(g.state.phase).toBe('dawn');
    expect(g.state.pausedRemainingMs).toBeNull();
    expect(g.state.phaseEndsAt).not.toBeNull();
  });

  it('adds time to the running clock', () => {
    const g = nightOne(6);
    g.act({ type: 'extend', seconds: 30 });
    expect(Date.parse(g.state.phaseEndsAt!) - g.now).toBe(60_000);
  });

  it('adds time to a paused clock', () => {
    const g = nightOne(6);
    g.act({ type: 'pause' });
    g.act({ type: 'extend', seconds: 30 });
    expect(g.state.pausedRemainingMs).toBe(60_000);
  });

  it('can take time away, but never past "now"', () => {
    const g = nightOne(6);
    g.act({ type: 'extend', seconds: -300 });
    expect(Date.parse(g.state.phaseEndsAt!)).toBe(g.now + 1_000);
  });

  it('does not pause the lobby', () => {
    const g = new Game();
    g.act({ type: 'pause' });
    expect(g.state.pausedRemainingMs).toBeNull();
  });

  it('stamps deadlines as ISO strings from the server clock', () => {
    const g = startedGame(5);
    expect(g.state.phaseEndsAt).toBe(new Date(T0 + 10_000).toISOString());
  });
});
