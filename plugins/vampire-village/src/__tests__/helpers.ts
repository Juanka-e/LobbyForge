/**
 * Test fixtures for the Vampire Village reducer.
 *
 * Everything runs through the real reducer with injected dependencies:
 * a controllable clock and a random source. `IDENTITY` makes the
 * Fisher–Yates shuffle a no-op, so roles land in seat order exactly as
 * `rolesForPlayerCount` lists them — vampires first, then seer, doctor,
 * survivor, hunter, jester, villagers. With 6 players that is:
 *
 *   p1 vampire · p2 seer · p3 doctor · p4 survivor · p5 hunter · p6 villager
 */
import { reduceVillage, type ReducerDeps } from '../reducer';
import { createVillageInitialState } from '../state';
import type { VillageAction, VillageRole, VillageState } from '../state';
import type { VillageMe, VillageView } from '../view';

/**
 * What `projectActivityState(state, 'vampire-village', viewer)` in
 * @lobbyforge/core hands a viewer — mirrored here because the plugin
 * cannot depend on core. The canonical rules and their leak tests live in
 * packages/core/src/__tests__/activity-projection.vampire.test.ts; this
 * copy only lets the panel helpers be tested against realistic views.
 */
export function asViewFor(state: VillageState, viewer: string | undefined): VillageView {
  const { secret, ...rest } = state;
  const role = viewer !== undefined ? secret.roles[viewer] : undefined;
  let me: VillageMe | null = null;
  if (viewer !== undefined && role) {
    const alive = state.players.some((p) => p.id === viewer && p.alive);
    const members = Object.keys(secret.roles).filter((id) => secret.roles[id] === 'vampire');
    const votes: Record<string, string> = {};
    for (const id of members) {
      const choice = secret.night[id];
      if (choice?.kind === 'bite') votes[id] = choice.targetId;
    }
    me = {
      id: viewer,
      role,
      alive,
      notes: secret.notes[viewer] ?? [],
      resources: secret.resources[viewer] ?? {},
      choice: alive ? (secret.night[viewer] ?? null) : null,
      pack: alive && role === 'vampire' ? { members, votes, chat: secret.packChat } : null,
    };
  }
  return state.phase === 'ended' ? { ...rest, me, secret } : { ...rest, me };
}

export const T0 = Date.parse('2026-09-28T12:00:00.000Z');

/** Makes the shuffle keep seat order (j === i on every step). */
export const IDENTITY = () => 0.999999;

export const NAMES: Record<string, string> = {
  p1: 'Ada',
  p2: 'Bram',
  p3: 'Cleo',
  p4: 'Dara',
  p5: 'Eli',
  p6: 'Fenn',
  p7: 'Gus',
  p8: 'Hana',
  p9: 'Ivo',
  p10: 'Juno',
  p11: 'Kaya',
  p12: 'Lior',
  p13: 'Mira',
};

export function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `p${i + 1}`);
}

export class Game {
  now = T0;
  state: VillageState;
  readonly deps: ReducerDeps;

  constructor(random: () => number = IDENTITY, state: VillageState = createVillageInitialState()) {
    this.state = state;
    this.deps = { now: () => this.now, random };
  }

  act(action: VillageAction): VillageState {
    this.state = reduceVillage(this.state, action, this.deps);
    return this.state;
  }

  /** Dispatch something the type system would refuse — the reducer must shrug it off. */
  actRaw(action: unknown): VillageState {
    this.state = reduceVillage(this.state, action as VillageAction, this.deps);
    return this.state;
  }

  tick(ms: number): void {
    this.now += ms;
  }

  join(id: string, name = NAMES[id] ?? id, color?: string): VillageState {
    return this.act({ type: 'join', playerId: id, name, ...(color ? { color } : {}) });
  }

  ready(id: string, ready = true): VillageState {
    return this.act({ type: 'set-ready', playerId: id, ready });
  }

  /** Everyone joins and readies up. */
  lobby(players: string[]): VillageState {
    for (const id of players) this.join(id);
    for (const id of players) this.ready(id);
    return this.state;
  }

  start(): VillageState {
    return this.act({ type: 'start' });
  }

  /** Host "next phase". */
  skip(): VillageState {
    return this.act({ type: 'advance', phaseId: this.state.phaseId });
  }

  /** Let the clock run out, then report it the way a client would. */
  expire(): VillageState {
    if (this.state.phaseEndsAt) this.now = Date.parse(this.state.phaseEndsAt);
    return this.act({ type: 'timeout', playerId: 'someone', phaseId: this.state.phaseId });
  }

  target(id: string, targetId: string | null): VillageState {
    return this.act({ type: 'night-target', playerId: id, targetId });
  }

  shield(id: string, raise: boolean): VillageState {
    return this.act({ type: 'night-shield', playerId: id, raise });
  }

  vote(id: string, targetId: string | null): VillageState {
    return this.act({ type: 'vote', playerId: id, targetId });
  }

  role(id: string): VillageRole | undefined {
    return this.state.secret.roles[id];
  }

  player(id: string) {
    const p = this.state.players.find((x) => x.id === id);
    if (!p) throw new Error(`no player ${id}`);
    return p;
  }

  alive(): string[] {
    return this.state.players.filter((p) => p.alive).map((p) => p.id);
  }

  logKinds(): string[] {
    return this.state.log.map((e) => e.kind);
  }
}

/** Joined, readied and started (phase: role_reveal). */
export function startedGame(n: number, random: () => number = IDENTITY): Game {
  const g = new Game(random);
  g.lobby(ids(n));
  g.start();
  return g;
}

/** A started game moved into night 1. */
export function nightOne(n: number): Game {
  const g = startedGame(n);
  g.skip();
  return g;
}

/**
 * 6 players, night 1 → the vampire bites `victim`, the seer looks at
 * `seerTarget`, the doctor protects `doctorTarget`, the survivor stays
 * unguarded. The hunter has nothing to do on night 1, so this ends the night.
 */
export function playNightOne(
  g: Game,
  { victim = 'p6', seerTarget = 'p1', doctorTarget = 'p3', shield = false } = {}
): VillageState {
  g.target('p1', victim);
  g.target('p2', seerTarget);
  g.target('p3', doctorTarget);
  return g.shield('p4', shield);
}
