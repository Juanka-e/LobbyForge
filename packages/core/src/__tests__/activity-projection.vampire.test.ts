/**
 * Vampire Village hidden information. The canonical state keeps every
 * secret under `state.secret` (roles, tonight's choices, private notes,
 * role resources, the pack chat, the night history); the projector must
 * hand each viewer only their own slice as `me` until the game ends.
 *
 * The fixture is night 2 of a 7-seat game:
 *   vamp1, vamp2  vampires (both alive)      seer    Cleo
 *   doctor        Dara                       villager Eli
 *   hunter        Fenn                       dead    Gus — the survivor, bitten on night 1
 * plus a spectator ("watcher") who holds no seat.
 */
import { describe, expect, it } from 'vitest';
import { projectActivityState } from '../activity-projection.js';

type Rec = Record<string, unknown>;

const AT = '2026-09-28T12:00:00.000Z';
const PLUGIN = 'vampire-village';

function player(id: string, name: string, seat: number, extra: Rec = {}): Rec {
  return { id, name, color: 'rose', seat, ready: true, alive: true, death: null, ...extra };
}

function nightTwo(phase = 'night'): Rec {
  return {
    version: 1,
    phase,
    round: 2,
    phaseId: 7,
    phaseStartedAt: AT,
    phaseEndsAt: '2026-09-28T12:00:30.000Z',
    pausedRemainingMs: null,
    settings: { nightSeconds: 30, daySeconds: 90, votingSeconds: 30 },
    players: [
      player('vamp1', 'Ada', 1),
      player('vamp2', 'Bram', 2),
      player('seer', 'Cleo', 3),
      player('doctor', 'Dara', 4),
      player('villager', 'Eli', 5),
      player('hunter', 'Fenn', 6),
      player('dead', 'Gus', 7, {
        alive: false,
        death: { round: 1, time: 'night', cause: 'bitten', role: 'survivor' },
      }),
    ],
    spectators: [{ id: 'watcher', name: 'Watcher' }],
    votes: {},
    chat: [{ id: 10, authorId: 'seer', text: 'public hello', at: AT, phaseId: 5 }],
    chatSent: {},
    log: [
      { id: 8, round: 1, time: 'setup', at: AT, kind: 'game-start', players: 7, vampires: 2 },
      { id: 9, round: 1, time: 'night', at: AT, kind: 'death', playerId: 'dead', cause: 'bitten', role: 'survivor' },
    ],
    jesterWinners: [],
    outcome: null,
    seq: 10, // public ids only: seats 1–7, the log, the village chat
    secret: {
      roles: {
        vamp1: 'vampire',
        vamp2: 'vampire',
        seer: 'seer',
        doctor: 'doctor',
        villager: 'villager',
        hunter: 'hunter',
        dead: 'survivor',
      },
      night: {
        vamp1: { kind: 'bite', targetId: 'villager' },
        vamp2: { kind: 'bite', targetId: 'doctor' },
        seer: { kind: 'inspect', targetId: 'vamp2' },
        doctor: { kind: 'protect', targetId: 'seer' },
        hunter: { kind: 'shoot', targetId: 'vamp1' },
      },
      notes: {
        seer: [{ kind: 'inspected', round: 1, targetId: 'vamp1', role: 'vampire' }],
        doctor: [{ kind: 'protected', round: 1, targetId: 'villager', attacked: false }],
        dead: [{ kind: 'shielded', round: 1, attacked: false }],
      },
      resources: {
        doctor: { lastProtectedId: 'villager' },
        hunter: { bullets: 2 },
        dead: { shields: 2 },
      },
      packChat: [{ id: 1, authorId: 'vamp1', text: 'the doctor keeps saving Eli', at: AT, phaseId: 7 }],
      packSent: { vamp1: 1 },
      packSeq: 1, // the pack counts its own messages — no gaps in public ids
      history: [
        {
          round: 1,
          choices: { vamp1: { kind: 'bite', targetId: 'dead' }, seer: { kind: 'inspect', targetId: 'vamp1' } },
          biteTargetId: 'dead',
          deaths: [{ playerId: 'dead', cause: 'bitten' }],
          saved: [],
        },
      ],
    },
  };
}

const view = (viewer: string | undefined, state: Rec = nightTwo()) =>
  projectActivityState(state, PLUGIN, viewer) as Rec;

const me = (viewer: string, state?: Rec) => view(viewer, state).me as Rec | null;

/** Every value found under a key named `role`, wherever it sits. */
function rolesIn(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => rolesIn(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Rec).flatMap(([key, v]) =>
    key === 'role' && typeof v === 'string' ? [`${path}.role=${v}`] : rolesIn(v, `${path}.${key}`)
  );
}

const EVERYONE = ['vamp1', 'vamp2', 'seer', 'doctor', 'villager', 'hunter', 'dead', 'watcher', undefined];
const NIGHT_KINDS = ['"bite"', '"inspect"', '"protect"', '"shoot"'];

describe('projectActivityState — vampire-village, while the game runs', () => {
  it('removes the secret block for every viewer', () => {
    for (const viewer of EVERYONE) {
      const out = view(viewer);
      expect(out.secret, `viewer=${viewer}`).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain('"roles"');
      expect(JSON.stringify(out)).not.toContain('"history"');
      // The pack's own message counter stays secret with the pack chat.
      expect(JSON.stringify(out)).not.toContain('packSeq');
    }
  });

  it('shows a viewer their own role — and no living player’s role anywhere else', () => {
    expect(rolesIn(view('villager')).sort()).toEqual([
      '$.log[1].role=survivor',
      '$.me.role=villager',
      '$.players[6].death.role=survivor', // the dead are public by design
    ]);
    expect(rolesIn(view('seer')).sort()).toEqual([
      '$.log[1].role=survivor',
      '$.me.notes[0].role=vampire', // the seer's own result from night 1
      '$.me.role=seer',
      '$.players[6].death.role=survivor',
    ]);
  });

  it('gives a vampire their pack: fellow vampires, the pack’s current votes and the pack chat', () => {
    expect(me('vamp1')).toEqual({
      id: 'vamp1',
      role: 'vampire',
      alive: true,
      notes: [],
      resources: {},
      choice: { kind: 'bite', targetId: 'villager' },
      pack: {
        members: ['vamp1', 'vamp2'],
        votes: { vamp1: 'villager', vamp2: 'doctor' },
        chat: [{ id: 1, authorId: 'vamp1', text: 'the doctor keeps saving Eli', at: AT, phaseId: 7 }],
      },
    });
    expect((me('vamp2')?.pack as Rec).members).toEqual(['vamp1', 'vamp2']);
  });

  it('a vampire cannot see the seer’s results', () => {
    const out = JSON.stringify(view('vamp1'));
    expect(out).not.toContain('inspected');
    expect(out).not.toContain('"inspect"');
  });

  it('a villager cannot see the pack chat, the pack or its votes', () => {
    const out = view('villager');
    expect(JSON.stringify(out)).not.toContain('the doctor keeps saving Eli');
    expect((out.me as Rec).pack).toBeNull();
    expect(JSON.stringify(out)).not.toContain('"bite"');
  });

  it('no non-vampire gets the pack', () => {
    for (const viewer of ['seer', 'doctor', 'villager', 'hunter', 'dead', 'watcher', undefined]) {
      const out = JSON.stringify(view(viewer));
      expect(out, `viewer=${viewer}`).not.toContain('the doctor keeps saving Eli');
      expect(out, `viewer=${viewer}`).not.toContain('"packChat"');
    }
  });

  it('the seer sees only their own inspections and their own choice', () => {
    expect(me('seer')).toEqual({
      id: 'seer',
      role: 'seer',
      alive: true,
      notes: [{ kind: 'inspected', round: 1, targetId: 'vamp1', role: 'vampire' }],
      resources: {},
      choice: { kind: 'inspect', targetId: 'vamp2' },
      pack: null,
    });
  });

  it('the doctor sees their own protection and who they cannot protect tonight', () => {
    expect(me('doctor')).toEqual({
      id: 'doctor',
      role: 'doctor',
      alive: true,
      notes: [{ kind: 'protected', round: 1, targetId: 'villager', attacked: false }],
      resources: { lastProtectedId: 'villager' },
      choice: { kind: 'protect', targetId: 'seer' },
      pack: null,
    });
  });

  it('nobody sees anyone else’s night choice', () => {
    const own: Record<string, string | null> = {
      vamp1: '"bite"',
      vamp2: '"bite"',
      seer: '"inspect"',
      doctor: '"protect"',
      hunter: '"shoot"',
      villager: null,
      dead: null,
      watcher: null,
    };
    for (const [viewer, kind] of Object.entries(own)) {
      const out = JSON.stringify(view(viewer));
      for (const other of NIGHT_KINDS.filter((k) => k !== kind)) {
        expect(out, `viewer=${viewer} must not see ${other}`).not.toContain(other);
      }
    }
    expect(me('hunter')).toMatchObject({ choice: { kind: 'shoot', targetId: 'vamp1' }, resources: { bullets: 2 } });
  });

  it('the dead keep their own role and notes but get no pack and no choice', () => {
    expect(me('dead')).toEqual({
      id: 'dead',
      role: 'survivor',
      alive: false,
      notes: [{ kind: 'shielded', round: 1, attacked: false }],
      resources: { shields: 2 },
      choice: null,
      pack: null,
    });
  });

  it('a dead vampire loses the pack', () => {
    const state = nightTwo();
    state.players = (state.players as Rec[]).map((p) =>
      p.id === 'vamp2' ? { ...p, alive: false, death: { round: 1, time: 'day', cause: 'hanged', role: 'vampire' } } : p
    );
    expect(me('vamp2', state)).toMatchObject({ role: 'vampire', alive: false, pack: null, choice: null });
    expect(JSON.stringify(view('vamp2', state))).not.toContain('the doctor keeps saving Eli');
  });

  it('spectators and anonymous viewers get public information only', () => {
    for (const viewer of ['watcher', 'not-in-the-game', undefined]) {
      const out = view(viewer);
      expect(out.me, `viewer=${viewer}`).toBeNull();
      expect(rolesIn(out)).toEqual(['$.players[6].death.role=survivor', '$.log[1].role=survivor']);
    }
  });

  it('keeps the public game intact', () => {
    const state = nightTwo();
    const out = view('villager', state);
    for (const key of ['phase', 'round', 'phaseId', 'phaseEndsAt', 'settings', 'players', 'spectators', 'votes', 'chat', 'log']) {
      expect(out[key], key).toEqual(state[key]);
    }
  });

  it('never lets a role ride along on a public player row (e.g. an older state shape)', () => {
    const state = nightTwo();
    state.players = (state.players as Rec[]).map((p) => ({ ...p, role: 'vampire' }));
    const out = view('villager', state);
    for (const row of out.players as Rec[]) expect(row).not.toHaveProperty('role');
  });

  it('does not mutate the canonical state', () => {
    const state = nightTwo();
    const before = JSON.parse(JSON.stringify(state));
    view('vamp1', state);
    view('seer', state);
    view(undefined, state);
    expect(state).toEqual(before);
  });

  it('copes with a missing or malformed secret block', () => {
    const out = projectActivityState({ phase: 'lobby', players: [] }, PLUGIN, 'u1') as Rec;
    expect(out.me).toBeNull();
    expect(out.secret).toBeUndefined();
    const odd = projectActivityState({ phase: 'night', players: 'x', secret: { roles: 'x' } }, PLUGIN, 'u1') as Rec;
    expect(odd.me).toBeNull();
    expect(odd.secret).toBeUndefined();
  });
});

describe('projectActivityState — vampire-village, once the game has ended', () => {
  it('makes everything public, for players and spectators alike', () => {
    const state = nightTwo('ended');
    for (const viewer of ['villager', 'watcher', undefined]) {
      const out = view(viewer, state);
      expect(out.secret, `viewer=${viewer}`).toEqual(state.secret);
    }
    expect(JSON.stringify(view('villager', state))).toContain('the doctor keeps saving Eli');
  });

  it('still tells a player which seat was theirs', () => {
    expect(me('seer', nightTwo('ended'))).toMatchObject({ id: 'seer', role: 'seer' });
  });
});
