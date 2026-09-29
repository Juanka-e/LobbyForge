import { describe, expect, it } from 'vitest';
import { Game, nightOne, playNightOne, startedGame } from './helpers';

/** 6 players; night 1 kills the villager p6; the game sits at dawn. */
function dawnOne(): Game {
  const g = nightOne(6);
  playNightOne(g, { victim: 'p6', doctorTarget: 'p2' });
  return g;
}

/** …and on to the vote of day 1 (5 alive: p1 vampire, p2–p5). */
function votingOne(): Game {
  const g = dawnOne();
  g.skip(); // dawn → day
  g.skip(); // day → voting
  return g;
}

describe('dawn and day', () => {
  it('walks dawn → discussion → vote on the configured timers', () => {
    const g = dawnOne();
    expect(g.state.phase).toBe('dawn');
    expect(Date.parse(g.state.phaseEndsAt!) - g.now).toBe(5_000);
    g.expire();
    expect(g.state.phase).toBe('day');
    expect(Date.parse(g.state.phaseEndsAt!) - g.now).toBe(90_000);
    g.expire();
    expect(g.state.phase).toBe('voting');
    expect(Date.parse(g.state.phaseEndsAt!) - g.now).toBe(30_000);
    expect(g.state.votes).toEqual({});
  });
});

describe('voting', () => {
  it('records one changeable vote per living player', () => {
    const g = votingOne();
    g.vote('p2', 'p1');
    g.vote('p2', 'p3');
    g.vote('p3', null);
    expect(g.state.votes).toEqual({ p2: 'p3', p3: null });
  });

  it('refuses votes from the dead, from spectators, for yourself and for the dead', () => {
    const g = votingOne();
    g.act({ type: 'join', playerId: 'watcher', name: 'Watcher' });
    g.vote('p6', 'p1'); // dead
    g.vote('watcher', 'p1'); // spectator
    g.vote('p2', 'p2'); // self
    g.vote('p3', 'p6'); // dead target
    g.vote('p4', 'ghost'); // not playing
    expect(g.state.votes).toEqual({});
  });

  it('only accepts votes during the vote', () => {
    const g = dawnOne();
    g.vote('p2', 'p1');
    expect(g.state.votes).toEqual({});
  });

  it('hangs the player a majority of the living voted for and reveals their role', () => {
    const g = votingOne();
    g.vote('p2', 'p3');
    g.vote('p4', 'p3');
    g.vote('p5', 'p3'); // 3 of 5 living — a majority
    g.expire();
    expect(g.state.phase).toBe('verdict');
    expect(g.player('p3').death).toEqual({ round: 1, time: 'day', cause: 'hanged', role: 'doctor' });
    expect(g.state.log.find((e) => e.kind === 'vote-result')).toMatchObject({
      kind: 'vote-result',
      round: 1,
      hangedId: 'p3',
      needed: 3,
      votes: { p2: 'p3', p4: 'p3', p5: 'p3' },
    });
  });

  it('hangs nobody without a majority', () => {
    const g = votingOne();
    g.vote('p2', 'p1');
    g.vote('p3', 'p1');
    g.vote('p4', 'p5');
    g.expire();
    expect(g.state.phase).toBe('verdict');
    expect(g.alive()).toHaveLength(5);
    expect(g.state.log.at(-1)).toMatchObject({ kind: 'vote-result', hangedId: null, needed: 3 });
  });

  it('counts "no one" votes as votes that hang nobody', () => {
    const g = votingOne();
    g.vote('p2', null);
    g.vote('p3', null);
    g.vote('p4', null);
    g.vote('p5', 'p1');
    g.expire();
    expect(g.alive()).toHaveLength(5);
  });

  it('closes the vote the moment every living player has voted', () => {
    const g = votingOne();
    g.vote('p1', 'p2');
    g.vote('p2', 'p1');
    g.vote('p3', 'p1');
    g.vote('p4', 'p1');
    expect(g.state.phase).toBe('voting');
    g.vote('p5', 'p1');
    expect(g.state.phase).toBe('ended'); // the only vampire was hanged
  });

  it('continues to the next night after the verdict, with the votes cleared', () => {
    const g = votingOne();
    g.expire(); // nobody voted
    expect(g.state.phase).toBe('verdict');
    expect(Date.parse(g.state.phaseEndsAt!) - g.now).toBe(5_000);
    g.expire();
    expect(g.state.phase).toBe('night');
    expect(g.state.round).toBe(2);
    expect(g.state.votes).toEqual({});
  });
});

describe('jester', () => {
  it('wins alone when the village hangs them, and the game goes on', () => {
    const g = nightOne(7); // p6 jester, p7 villager
    playNightOne(g, { victim: 'p7', doctorTarget: 'p2' });
    g.skip();
    g.skip();
    for (const voter of ['p1', 'p2', 'p3', 'p4']) g.vote(voter, 'p6');
    g.expire();
    expect(g.player('p6').death).toMatchObject({ cause: 'hanged', role: 'jester' });
    expect(g.state.jesterWinners).toEqual(['p6']);
    expect(g.logKinds()).toContain('jester-win');
    expect(g.state.phase).toBe('verdict');
  });

  it('simply dies when bitten at night', () => {
    const g = nightOne(7);
    playNightOne(g, { victim: 'p6', doctorTarget: 'p2' });
    expect(g.player('p6').death).toMatchObject({ cause: 'bitten', role: 'jester' });
    expect(g.state.jesterWinners).toEqual([]);
  });
});

describe('winning', () => {
  it('gives the village the win when the last vampire hangs — dead villagers win too', () => {
    const g = votingOne();
    for (const voter of ['p2', 'p3', 'p4', 'p5']) g.vote(voter, 'p1');
    g.vote('p1', 'p2');
    expect(g.state.phase).toBe('ended');
    expect(g.state.phaseEndsAt).toBeNull();
    expect(g.state.outcome).toEqual({
      winner: 'village',
      reason: 'vampires-gone',
      // village team (seer, doctor, hunter, the dead villager) + the surviving survivor
      winners: ['p2', 'p3', 'p5', 'p6', 'p4'],
    });
    expect(g.state.log.at(-1)).toMatchObject({ kind: 'game-over', winner: 'village', reason: 'vampires-gone' });
  });

  it('gives the vampires the win once they match the living village team (neutrals do not count)', () => {
    // 5 players: p1 vampire, p2 seer, p3 doctor, p4 survivor, p5 villager.
    const g = startedGame(5);
    g.skip();
    g.target('p1', 'p5');
    g.target('p2', 'p1');
    g.target('p3', 'p3');
    g.shield('p4', false);
    expect(g.state.phase).toBe('dawn'); // 1 vampire vs 2 village (+1 survivor)
    g.skip();
    g.skip();
    for (const voter of ['p1', 'p3', 'p4']) g.vote(voter, 'p2'); // the seer is hanged
    g.vote('p2', 'p1');
    // 1 vampire vs 1 villager (the doctor) and the survivor: parity
    expect(g.state.phase).toBe('ended');
    expect(g.state.outcome).toEqual({ winner: 'vampires', reason: 'vampires-parity', winners: ['p1', 'p4'] });
  });

  it('lists a jester who was hanged earlier among the winners', () => {
    const g = nightOne(7);
    playNightOne(g, { victim: 'p7', doctorTarget: 'p2' });
    g.skip();
    g.skip();
    for (const voter of ['p1', 'p2', 'p3', 'p4']) g.vote(voter, 'p6');
    g.expire(); // jester hanged → verdict
    g.skip(); // night 2
    g.target('p1', 'p2');
    g.target('p2', 'p1');
    g.target('p3', 'p3');
    g.shield('p4', false);
    g.target('p5', 'p1'); // the hunter shoots the vampire
    expect(g.state.phase).toBe('ended');
    expect(g.state.outcome?.winner).toBe('village');
    expect(g.state.outcome?.winners).toEqual(['p2', 'p3', 'p5', 'p7', 'p4', 'p6']);
  });

  it('declares no winning team when the last vampire and the last villager fall together', () => {
    // 6 players; bring it down to vampire + hunter + survivor, then trade shots.
    const g = nightOne(6);
    g.state = {
      ...g.state,
      round: 2,
      players: g.state.players.map((p) =>
        ['p2', 'p3', 'p6'].includes(p.id)
          ? { ...p, alive: false, death: { round: 1, time: 'night' as const, cause: 'bitten' as const, role: g.role(p.id)! } }
          : p
      ),
    };
    g.target('p5', 'p1'); // hunter shoots the vampire
    g.target('p1', 'p5'); // vampire bites the hunter
    g.shield('p4', false);
    expect(g.state.phase).toBe('ended');
    expect(g.state.outcome).toEqual({ winner: null, reason: 'no-team-left', winners: ['p4'] });
  });
});
