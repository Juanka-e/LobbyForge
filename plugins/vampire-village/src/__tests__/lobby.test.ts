import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VILLAGE_SETTINGS,
  MAX_PLAYERS,
  PLAYER_COLORS,
  VV_STATE_VERSION,
  createVillageInitialState,
} from '../state';
import { Game, T0, ids, startedGame } from './helpers';

describe('initial state', () => {
  it('opens an empty lobby with the default timers', () => {
    const s = createVillageInitialState();
    expect(s.version).toBe(VV_STATE_VERSION);
    expect(s.phase).toBe('lobby');
    expect(s.round).toBe(0);
    expect(s.players).toEqual([]);
    expect(s.spectators).toEqual([]);
    expect(s.phaseEndsAt).toBeNull();
    expect(s.settings).toEqual(DEFAULT_VILLAGE_SETTINGS);
    expect(DEFAULT_VILLAGE_SETTINGS).toEqual({ nightSeconds: 30, daySeconds: 90, votingSeconds: 30 });
    expect(s.secret.roles).toEqual({});
    expect(s.outcome).toBeNull();
  });
});

describe('join', () => {
  it('seats a player with a trimmed character name and a colour', () => {
    const g = new Game();
    g.join('p1', '  Ada   Lovelace ', 'violet');
    expect(g.state.players).toEqual([
      { id: 'p1', name: 'Ada Lovelace', color: 'violet', seat: 1, ready: false, alive: true, death: null },
    ]);
  });

  it('gives each newcomer the first free colour when none (or an unknown one) is picked', () => {
    const g = new Game();
    g.join('p1');
    g.join('p2', 'Bram', 'not-a-colour');
    expect(g.player('p1').color).toBe(PLAYER_COLORS[0]);
    expect(g.player('p2').color).toBe(PLAYER_COLORS[1]);
  });

  it('refuses an empty or overlong name', () => {
    const g = new Game();
    g.join('p1', '   ');
    g.join('p2', 'x'.repeat(25));
    expect(g.state.players).toEqual([]);
  });

  it('refuses a name another player already uses, whatever the case', () => {
    const g = new Game();
    g.join('p1', 'Ada');
    g.join('p2', 'ADA');
    expect(g.state.players.map((p) => p.id)).toEqual(['p1']);
  });

  it('lets a seated player change their name and colour without taking a new seat', () => {
    const g = new Game();
    g.join('p1', 'Ada');
    g.join('p2', 'Bram');
    g.join('p1', 'Ada the Bold', 'mint');
    expect(g.state.players.map((p) => [p.id, p.name, p.color, p.seat])).toEqual([
      ['p1', 'Ada the Bold', 'mint', 1],
      ['p2', 'Bram', PLAYER_COLORS[1], 2],
    ]);
  });

  it('seats at most 12 — the 13th watches as a spectator', () => {
    const g = new Game();
    for (const id of ids(MAX_PLAYERS + 1)) g.join(id);
    expect(g.state.players).toHaveLength(MAX_PLAYERS);
    expect(g.state.spectators).toEqual([{ id: 'p13', name: 'Mira' }]);
  });

  it('turns a late joiner into a spectator once the game is running', () => {
    const g = startedGame(5);
    g.join('late', 'Latecomer');
    g.join('late', 'Latecomer');
    expect(g.state.players.some((p) => p.id === 'late')).toBe(false);
    expect(g.state.spectators).toEqual([{ id: 'late', name: 'Latecomer' }]);
  });

  it('does not let a seated player rename themselves mid-game', () => {
    const g = startedGame(5);
    g.join('p1', 'Someone Else');
    expect(g.player('p1').name).toBe('Ada');
    expect(g.state.spectators).toEqual([]);
  });

  it('moves a spectator into a free seat when they join the lobby', () => {
    const g = new Game();
    for (const id of ids(MAX_PLAYERS + 1)) g.join(id);
    g.act({ type: 'leave', playerId: 'p1' });
    g.join('p13');
    expect(g.state.players.some((p) => p.id === 'p13')).toBe(true);
    expect(g.state.spectators).toEqual([]);
  });
});

describe('leave and ready (lobby)', () => {
  it('frees the seat when a player leaves the lobby', () => {
    const g = new Game();
    g.join('p1');
    g.join('p2');
    g.act({ type: 'leave', playerId: 'p1' });
    expect(g.state.players.map((p) => p.id)).toEqual(['p2']);
  });

  it('keeps seat numbers growing after someone leaves', () => {
    const g = new Game();
    g.join('p1');
    g.join('p2');
    g.act({ type: 'leave', playerId: 'p2' });
    g.join('p3');
    expect(g.player('p3').seat).toBe(3);
  });

  it('toggles ready for a seated player only', () => {
    const g = new Game();
    g.join('p1');
    g.ready('p1');
    g.ready('stranger');
    expect(g.player('p1').ready).toBe(true);
    g.ready('p1', false);
    expect(g.player('p1').ready).toBe(false);
  });
});

describe('configure', () => {
  it('clamps timers into their ranges and keeps what was not sent', () => {
    const g = new Game();
    g.act({ type: 'configure', settings: { nightSeconds: 5, daySeconds: 100_000 } });
    expect(g.state.settings).toEqual({ nightSeconds: 15, daySeconds: 600, votingSeconds: 30 });
    g.act({ type: 'configure', settings: { votingSeconds: 44.6 } });
    expect(g.state.settings.votingSeconds).toBe(45);
  });

  it('ignores values that are not numbers', () => {
    const g = new Game();
    g.actRaw({ type: 'configure', settings: { nightSeconds: 'soon', daySeconds: Number.NaN } });
    expect(g.state.settings).toEqual(DEFAULT_VILLAGE_SETTINGS);
  });

  it('still works mid-game (the change applies from the next phase)', () => {
    const g = startedGame(5);
    const before = g.state.phaseEndsAt;
    g.act({ type: 'configure', settings: { nightSeconds: 60 } });
    expect(g.state.settings.nightSeconds).toBe(60);
    expect(g.state.phaseEndsAt).toBe(before);
    g.skip();
    expect(Date.parse(g.state.phaseEndsAt!) - g.now).toBe(60_000);
  });
});

describe('start', () => {
  it('needs at least five players', () => {
    const g = new Game();
    g.lobby(ids(4));
    g.start();
    expect(g.state.phase).toBe('lobby');
  });

  it('needs every seated player to be ready', () => {
    const g = new Game();
    g.lobby(ids(5));
    g.ready('p3', false);
    g.start();
    expect(g.state.phase).toBe('lobby');
    g.ready('p3');
    g.start();
    expect(g.state.phase).toBe('role_reveal');
  });

  it('deals the spec composition in seat order with the identity shuffle', () => {
    const g = startedGame(6);
    expect(g.state.secret.roles).toEqual({
      p1: 'vampire',
      p2: 'seer',
      p3: 'doctor',
      p4: 'survivor',
      p5: 'hunter',
      p6: 'villager',
    });
  });

  it('shuffles with the server-side random source', () => {
    const g = startedGame(6, () => 0);
    // random() === 0 always swaps with index 0: a rotation, not seat order.
    expect(g.state.secret.roles.p1).not.toBe('vampire');
    expect(Object.values(g.state.secret.roles).sort()).toEqual(
      ['doctor', 'hunter', 'seer', 'survivor', 'vampire', 'villager']
    );
  });

  it('hands out the role resources: two bullets, three shields', () => {
    const g = startedGame(6);
    expect(g.state.secret.resources).toEqual({
      p3: { lastProtectedId: null },
      p4: { shields: 3 },
      p5: { bullets: 2 },
    });
  });

  it('opens a 10 second role reveal and logs the start', () => {
    const g = startedGame(8);
    expect(g.state.phase).toBe('role_reveal');
    expect(g.state.round).toBe(1);
    expect(g.state.phaseStartedAt).toBe(new Date(T0).toISOString());
    expect(g.state.phaseEndsAt).toBe(new Date(T0 + 10_000).toISOString());
    expect(g.state.log).toEqual([
      expect.objectContaining({ kind: 'game-start', players: 8, vampires: 2, round: 1, time: 'setup' }),
    ]);
  });

  it('bumps the phase id on every phase change', () => {
    const g = new Game();
    g.lobby(ids(5));
    const lobbyPhase = g.state.phaseId;
    g.start();
    expect(g.state.phaseId).toBe(lobbyPhase + 1);
    g.skip();
    expect(g.state.phaseId).toBe(lobbyPhase + 2);
  });

  it('cannot start twice', () => {
    const g = startedGame(5);
    const snapshot = g.state;
    g.start();
    expect(g.state).toBe(snapshot);
  });
});
