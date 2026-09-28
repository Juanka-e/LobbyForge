import { describe, expect, it } from 'vitest';
import { Game, nightOne, playNightOne, startedGame } from './helpers';

describe('entering the night', () => {
  it('starts night 1 after the role reveal, timed by the night setting', () => {
    const g = nightOne(6);
    expect(g.state.phase).toBe('night');
    expect(g.state.round).toBe(1);
    expect(Date.parse(g.state.phaseEndsAt!) - g.now).toBe(30_000);
  });

  it('also gets there when the reveal timer runs out', () => {
    const g = startedGame(6);
    g.expire();
    expect(g.state.phase).toBe('night');
  });
});

describe('vampires', () => {
  it('records a bite on a living non-vampire', () => {
    const g = nightOne(6);
    g.target('p1', 'p6');
    expect(g.state.secret.night.p1).toEqual({ kind: 'bite', targetId: 'p6' });
  });

  it('cannot bite a fellow vampire, themselves, or someone who is not playing', () => {
    const g = nightOne(8); // p1 + p2 are vampires
    g.target('p1', 'p2');
    g.target('p1', 'p1');
    g.target('p1', 'ghost');
    expect(g.state.secret.night.p1).toBeUndefined();
  });

  it('needs a majority of the living pack: both of two vampires must agree', () => {
    const g = nightOne(8);
    // Everyone else acts first so only the pack is outstanding.
    g.target('p3', 'p4'); // seer
    g.target('p4', 'p4'); // doctor protects himself
    g.shield('p5', false); // survivor
    g.target('p1', 'p8');
    expect(g.state.phase).toBe('night');
    g.target('p2', 'p7');
    expect(g.state.phase).toBe('night'); // split vote
    g.target('p2', 'p8');
    expect(g.state.phase).toBe('dawn');
    expect(g.player('p8').alive).toBe(false);
  });

  it('can withdraw a vote with a null target', () => {
    const g = nightOne(6);
    g.target('p1', 'p6');
    g.target('p1', null);
    expect(g.state.secret.night.p1).toBeUndefined();
  });

  it('kills nobody when the pack never agrees before the timer runs out', () => {
    const g = nightOne(8);
    g.target('p1', 'p8');
    g.target('p2', 'p7');
    g.expire();
    expect(g.state.phase).toBe('dawn');
    expect(g.alive()).toHaveLength(8);
    expect(g.logKinds()).toContain('quiet-night');
  });
});

describe('ending the night early', () => {
  it('ends as soon as every night role has chosen (the hunter rests on night 1)', () => {
    const g = nightOne(6);
    playNightOne(g);
    expect(g.state.phase).toBe('dawn');
  });

  it('waits for anyone who still has a choice to make', () => {
    const g = nightOne(6);
    g.target('p1', 'p6');
    g.target('p2', 'p1');
    g.target('p3', 'p3');
    expect(g.state.phase).toBe('night'); // survivor has not decided
  });

  it('stops waiting for a survivor with no shields left or a hunter with no bullets', () => {
    const g = nightOne(6);
    g.state = {
      ...g.state,
      round: 2,
      secret: { ...g.state.secret, resources: { ...g.state.secret.resources, p4: { shields: 0 }, p5: { bullets: 0 } } },
    };
    g.target('p1', 'p6');
    g.target('p2', 'p1');
    g.target('p3', 'p3');
    expect(g.state.phase).toBe('dawn');
  });
});

describe('seer', () => {
  it('learns the true role at dawn, privately', () => {
    const g = nightOne(6);
    g.target('p2', 'p1');
    expect(g.state.secret.notes.p2 ?? []).toEqual([]);
    playNightOne(g, { seerTarget: 'p1' });
    expect(g.state.secret.notes.p2).toEqual([{ kind: 'inspected', round: 1, targetId: 'p1', role: 'vampire' }]);
  });

  it('cannot look at themselves', () => {
    const g = nightOne(6);
    g.target('p2', 'p2');
    expect(g.state.secret.night.p2).toBeUndefined();
  });

  it('may skip the night', () => {
    const g = nightOne(6);
    g.target('p2', null);
    expect(g.state.secret.night.p2).toEqual({ kind: 'skip' });
  });
});

describe('doctor', () => {
  it('saves the bitten player — nobody dies and the attack is reported as stopped', () => {
    const g = nightOne(6);
    playNightOne(g, { victim: 'p6', doctorTarget: 'p6' });
    expect(g.alive()).toHaveLength(6);
    expect(g.logKinds()).toEqual(['game-start', 'quiet-night', 'attack-stopped']);
    expect(g.state.log.at(-1)).toMatchObject({ kind: 'attack-stopped', count: 1 });
    // Only the doctor and the saved player learn who it was.
    expect(g.state.secret.notes.p3).toEqual([{ kind: 'protected', round: 1, targetId: 'p6', attacked: true }]);
    expect(g.state.secret.notes.p6).toEqual([{ kind: 'survived', round: 1 }]);
    expect(JSON.stringify(g.state.log)).not.toContain('p6');
  });

  it('may protect themselves', () => {
    const g = nightOne(6);
    playNightOne(g, { victim: 'p3', doctorTarget: 'p3' });
    expect(g.player('p3').alive).toBe(true);
  });

  it('cannot protect the same player two nights in a row', () => {
    const g = nightOne(6);
    playNightOne(g, { victim: 'p6', doctorTarget: 'p2' });
    expect(g.state.secret.resources.p3).toEqual({ lastProtectedId: 'p2' });
    g.skip(); // dawn → day
    g.skip(); // day → voting
    g.skip(); // voting → verdict (no votes)
    g.skip(); // verdict → night 2
    expect(g.state.phase).toBe('night');
    g.target('p3', 'p2');
    expect(g.state.secret.night.p3).toBeUndefined();
    g.target('p3', 'p4');
    expect(g.state.secret.night.p3).toEqual({ kind: 'protect', targetId: 'p4' });
  });

  it('forgets last night’s patient after a night without protecting anyone', () => {
    const g = nightOne(6);
    playNightOne(g, { victim: 'p6', doctorTarget: 'p2' });
    g.skip();
    g.skip();
    g.skip();
    g.skip(); // night 2
    g.target('p3', null);
    g.expire(); // night 2 ends with the doctor skipping
    expect(g.state.secret.resources.p3).toEqual({ lastProtectedId: null });
  });
});

describe('survivor', () => {
  it('spends a shield to survive a bite', () => {
    const g = nightOne(6);
    playNightOne(g, { victim: 'p4', doctorTarget: 'p2', shield: true });
    expect(g.player('p4').alive).toBe(true);
    expect(g.state.secret.resources.p4).toEqual({ shields: 2 });
    expect(g.state.secret.notes.p4).toEqual([
      { kind: 'shielded', round: 1, attacked: true },
      { kind: 'survived', round: 1 },
    ]);
  });

  it('spends the shield even on a quiet night', () => {
    const g = nightOne(6);
    playNightOne(g, { victim: 'p6', doctorTarget: 'p2', shield: true });
    expect(g.state.secret.resources.p4).toEqual({ shields: 2 });
    expect(g.state.secret.notes.p4).toEqual([{ kind: 'shielded', round: 1, attacked: false }]);
  });

  it('dies like anyone else when the shield stays down', () => {
    const g = nightOne(6);
    playNightOne(g, { victim: 'p4', doctorTarget: 'p2', shield: false });
    expect(g.player('p4').alive).toBe(false);
  });

  it('cannot raise a shield with none left', () => {
    const g = nightOne(6);
    g.state = { ...g.state, secret: { ...g.state.secret, resources: { ...g.state.secret.resources, p4: { shields: 0 } } } };
    g.shield('p4', true);
    expect(g.state.secret.night.p4).toBeUndefined();
  });
});

/** Play night 1 quietly (doctor saves the bite), then walk to night 2. */
function toNightTwo(n = 6): Game {
  const g = nightOne(n);
  playNightOne(g, { victim: 'p6', doctorTarget: 'p6' });
  g.skip(); // dawn → day
  g.skip(); // day → voting
  g.skip(); // voting → verdict
  g.skip(); // verdict → night 2
  return g;
}

describe('hunter', () => {
  it('cannot shoot on the first night', () => {
    const g = nightOne(6);
    g.target('p5', 'p1');
    expect(g.state.secret.night.p5).toBeUndefined();
  });

  it('shoots from the second night and spends a bullet', () => {
    const g = toNightTwo();
    expect(g.state.round).toBe(2);
    g.target('p5', 'p1');
    expect(g.state.secret.night.p5).toEqual({ kind: 'shoot', targetId: 'p1' });
    g.target('p1', 'p2'); // vampire bites the seer
    g.target('p2', 'p5');
    g.target('p3', 'p3');
    g.shield('p4', false);
    expect(g.state.phase).not.toBe('night');
    expect(g.player('p1').alive).toBe(false); // the vampire was shot
    expect(g.player('p1').death).toMatchObject({ cause: 'shot', role: 'vampire', round: 2 });
    expect(g.player('p5').alive).toBe(true); // no remorse for shooting a vampire
    expect(g.state.secret.resources.p5).toEqual({ bullets: 1 });
    expect(g.state.secret.notes.p5).toEqual([{ kind: 'shot', round: 2, targetId: 'p1', result: 'killed', remorse: false }]);
  });

  it('dies of remorse after killing an innocent villager', () => {
    const g = toNightTwo();
    g.target('p5', 'p6'); // the villager
    g.target('p1', 'p2');
    g.target('p2', 'p1');
    g.target('p3', 'p3');
    g.shield('p4', false);
    expect(g.player('p6').death).toMatchObject({ cause: 'shot' });
    expect(g.player('p5').death).toMatchObject({ cause: 'remorse', role: 'hunter' });
    expect(g.state.secret.notes.p5?.at(-1)).toMatchObject({ kind: 'shot', result: 'killed', remorse: true });
  });

  it('feels no remorse when the doctor blocks the shot', () => {
    const g = toNightTwo();
    g.target('p5', 'p2'); // shoots the seer (village team)…
    g.target('p1', 'p6');
    g.target('p2', 'p1');
    g.target('p3', 'p2'); // …whom the doctor covers tonight
    g.shield('p4', false);
    expect(g.player('p2').alive).toBe(true);
    expect(g.player('p5').alive).toBe(true);
    expect(g.player('p6').death).toMatchObject({ cause: 'bitten', round: 2 });
    expect(g.state.secret.notes.p5?.at(-1)).toMatchObject({
      kind: 'shot',
      targetId: 'p2',
      result: 'blocked',
      remorse: false,
    });
  });

  it('dies of remorse even when the vampires bit the same villager', () => {
    const g = toNightTwo();
    g.target('p5', 'p2');
    g.target('p1', 'p2');
    g.target('p2', 'p1');
    g.target('p3', 'p3');
    g.shield('p4', false);
    expect(g.player('p2').death).toMatchObject({ cause: 'shot' }); // the shot resolves first (spec §10)
    expect(g.player('p5').death).toMatchObject({ cause: 'remorse' });
  });

  it('shooting the survivor behind a shield is blocked, with no remorse', () => {
    const g = toNightTwo();
    g.target('p5', 'p4');
    g.target('p1', 'p2');
    g.target('p2', 'p1');
    g.target('p3', 'p3');
    g.shield('p4', true);
    expect(g.player('p4').alive).toBe(true);
    expect(g.player('p5').alive).toBe(true);
    expect(g.state.secret.notes.p5?.at(-1)).toMatchObject({ kind: 'shot', result: 'blocked', remorse: false });
  });

  it('may hold fire, keeping the bullet', () => {
    const g = toNightTwo();
    g.target('p5', null);
    expect(g.state.secret.night.p5).toEqual({ kind: 'skip' });
    g.expire();
    expect(g.state.secret.resources.p5).toEqual({ bullets: 2 });
  });

  it('cannot shoot with an empty gun', () => {
    const g = toNightTwo();
    g.state = { ...g.state, secret: { ...g.state.secret, resources: { ...g.state.secret.resources, p5: { bullets: 0 } } } };
    g.target('p5', 'p1');
    expect(g.state.secret.night.p5).toBeUndefined();
  });
});

describe('night bookkeeping', () => {
  it('reveals a night victim’s role publicly and logs how they died', () => {
    const g = nightOne(6);
    playNightOne(g, { victim: 'p6', doctorTarget: 'p2' });
    expect(g.player('p6')).toMatchObject({
      alive: false,
      death: { round: 1, time: 'night', cause: 'bitten', role: 'villager' },
    });
    expect(g.state.log.at(-1)).toMatchObject({
      kind: 'death',
      playerId: 'p6',
      cause: 'bitten',
      role: 'villager',
      round: 1,
      time: 'night',
    });
  });

  it('keeps the full night in the secret history for the end screen', () => {
    const g = nightOne(6);
    playNightOne(g, { victim: 'p6', seerTarget: 'p1', doctorTarget: 'p2' });
    expect(g.state.secret.history).toEqual([
      {
        round: 1,
        choices: {
          p1: { kind: 'bite', targetId: 'p6' },
          p2: { kind: 'inspect', targetId: 'p1' },
          p3: { kind: 'protect', targetId: 'p2' },
          p4: { kind: 'shield', raise: false },
        },
        biteTargetId: 'p6',
        deaths: [{ playerId: 'p6', cause: 'bitten' }],
        saved: [],
      },
    ]);
    expect(g.state.secret.night).toEqual({});
  });

  it('refuses night actions from roles without one, from the dead and outside the night', () => {
    const g = nightOne(7); // p6 jester, p7 villager
    g.target('p6', 'p1');
    g.target('p7', 'p1');
    expect(g.state.secret.night).toEqual({});
    playNightOne(g, { victim: 'p7', doctorTarget: 'p2' });
    expect(g.state.phase).toBe('dawn');
    g.target('p2', 'p1');
    expect(g.state.secret.night).toEqual({});
  });

  it('ignores the choices of anyone who died before dawn', () => {
    const g = nightOne(6);
    g.target('p2', 'p1'); // the seer looks at the vampire…
    g.act({ type: 'leave', playerId: 'p2' }); // …then walks out
    playNightOne(g, { victim: 'p6', seerTarget: 'p1', doctorTarget: 'p3' });
    expect(g.state.secret.notes.p2 ?? []).toEqual([]);
  });

  it('refuses every night action while the host has paused the game', () => {
    const g = nightOne(6);
    g.act({ type: 'pause' });
    g.target('p1', 'p6');
    g.shield('p4', true);
    expect(g.state.secret.night).toEqual({});
  });
});
