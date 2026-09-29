/**
 * Vampire Village reducer — the only thing that changes game state.
 *
 * Pure apart from two injected dependencies, which the host never lets a
 * client influence:
 *  - `now`: the SERVER clock. Deadlines are stamped with it, and a
 *    `timeout` is only honoured once the server agrees the deadline has
 *    passed, so no client can cut a phase short.
 *  - `random`: the role shuffle. It runs inside the host's action route,
 *    exactly like Hushle's card draw — the `start` action carries no
 *    roles, no seed, nothing a client could steer. The default reads the
 *    platform CSPRNG (`crypto.getRandomValues`).
 *
 * Every handler returns the SAME state object when it refuses an action,
 * so "nothing happened" is cheap to detect and never persisted as a change.
 */
import {
  CHAT_KEEP,
  CHAT_MAX_LENGTH,
  CHAT_PER_PHASE,
  LOG_KEEP,
  MAX_PLAYERS,
  MAX_SPECTATORS,
  MIN_PLAYERS,
  NAME_MAX_LENGTH,
  PACK_CHAT_KEEP,
  PACK_CHAT_PER_PHASE,
  PLAYER_COLORS,
  SETTING_LIMITS,
  createVillageInitialState,
  emptySecret,
} from './state';
import type {
  VillageAction,
  VillageChatMessage,
  VillageColor,
  VillageDeathCause,
  VillageEndReason,
  VillageLogEntry,
  VillageNightChoice,
  VillageNote,
  VillagePhase,
  VillagePlayer,
  VillageResources,
  VillageRole,
  VillageSettings,
  VillageState,
  VillageTime,
  VillageWinner,
} from './state';
import {
  DAWN_SECONDS,
  HUNTER_BULLETS,
  HUNTER_FIRST_NIGHT,
  ROLE_REVEAL_SECONDS,
  SURVIVOR_SHIELDS,
  TIMEOUT_TOLERANCE_MS,
  VERDICT_SECONDS,
  majorityNeeded,
  rolesForPlayerCount,
  teamOf,
} from './rules';
import { validateVillageAction } from './validate';

export interface ReducerDeps {
  /** Epoch milliseconds, server time. */
  now: () => number;
  /** A float in [0, 1). */
  random: () => number;
}

/** A float in [0, 1) from the platform CSPRNG, or Math.random where there is none. */
export function secureRandom(): number {
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint32Array) => Uint32Array } }).crypto;
  if (cryptoApi?.getRandomValues) {
    const buffer = new Uint32Array(1);
    cryptoApi.getRandomValues(buffer);
    return buffer[0]! / 0x1_0000_0000;
  }
  return Math.random();
}

export const DEFAULT_DEPS: ReducerDeps = { now: () => Date.now(), random: secureRandom };

type Action<T extends VillageAction['type']> = Extract<VillageAction, { type: T }>;

export function reduceVillage(
  state: VillageState,
  action: VillageAction,
  deps: ReducerDeps = DEFAULT_DEPS
): VillageState {
  // Defence in depth: the host already ran validateAction, but the
  // reducer never trusts a shape it did not check itself.
  if (validateVillageAction(action) !== null) return state;
  switch (action.type) {
    case 'join':
      return join(state, action, deps);
    case 'leave':
      return leave(state, action, deps);
    case 'set-ready':
      return setReady(state, action);
    case 'configure':
      return configure(state, action);
    case 'start':
      return start(state, deps);
    case 'kick':
      return kick(state, action, deps);
    case 'advance':
      return isRunning(state.phase) && action.phaseId === state.phaseId ? endPhase(state, deps.now()) : state;
    case 'timeout':
      return timeout(state, action, deps);
    case 'pause':
      return pause(state, deps);
    case 'resume':
      return resume(state, deps);
    case 'extend':
      return extend(state, action, deps);
    case 'night-target':
      return nightTarget(state, action, deps);
    case 'night-shield':
      return nightShield(state, action, deps);
    case 'vote':
      return vote(state, action, deps);
    case 'chat':
      return chat(state, action, deps);
    case 'pack-chat':
      return packChat(state, action, deps);
    case 'play-again':
      return playAgain(state, deps);
    case 'end-game':
      return isRunning(state.phase) ? endGame(state, null, 'host-ended', deps.now()) : state;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();

/** Phases with a clock: everything between the lobby and the end screen. */
function isRunning(phase: VillagePhase): boolean {
  return phase !== 'lobby' && phase !== 'ended';
}

function isPaused(state: VillageState): boolean {
  return state.pausedRemainingMs !== null;
}

function timeOf(phase: VillagePhase): 'night' | 'day' {
  return phase === 'role_reveal' || phase === 'night' ? 'night' : 'day';
}

function livingPlayer(state: VillageState, id: string | null | undefined): VillagePlayer | undefined {
  if (!id) return undefined;
  return state.players.find((p) => p.id === id && p.alive);
}

function roleOf(state: VillageState, id: string): VillageRole | undefined {
  return Object.prototype.hasOwnProperty.call(state.secret.roles, id) ? state.secret.roles[id] : undefined;
}

function resourcesOf(state: VillageState, id: string): VillageResources {
  return state.secret.resources[id] ?? {};
}

/**
 * Names and chat: control characters (and bidi overrides, which can make a
 * name read backwards) become spaces, runs of whitespace collapse, ends trim.
 */
export function tidyText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001F\u007F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isColor(value: unknown): value is VillageColor {
  return typeof value === 'string' && (PLAYER_COLORS as readonly string[]).includes(value);
}

function firstFreeColor(players: VillagePlayer[]): VillageColor {
  const taken = new Set(players.map((p) => p.color));
  return PLAYER_COLORS.find((c) => !taken.has(c)) ?? PLAYER_COLORS[players.length % PLAYER_COLORS.length]!;
}

type LogBody = VillageLogEntry extends infer E ? (E extends unknown ? Omit<E, 'id' | 'round' | 'time' | 'at'> : never) : never;

function appendLog(state: VillageState, body: LogBody, time: VillageTime, now: number): VillageState {
  const id = state.seq + 1;
  const entry = { ...body, id, round: state.round, time, at: iso(now) } as VillageLogEntry;
  const log = [...state.log, entry];
  return { ...state, seq: id, log: log.length > LOG_KEEP ? log.slice(-LOG_KEEP) : log };
}

function appendMessage(
  list: VillageChatMessage[],
  message: VillageChatMessage,
  keep: number
): VillageChatMessage[] {
  const next = [...list, message];
  return next.length > keep ? next.slice(-keep) : next;
}

/** Fisher–Yates with an injected random source. */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const r = random();
    const j = Math.min(i, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * (i + 1))));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phases and the clock
// ---------------------------------------------------------------------------

function phaseSeconds(settings: VillageSettings, phase: VillagePhase): number | null {
  switch (phase) {
    case 'role_reveal':
      return ROLE_REVEAL_SECONDS;
    case 'night':
      return settings.nightSeconds;
    case 'dawn':
      return DAWN_SECONDS;
    case 'day':
      return settings.daySeconds;
    case 'voting':
      return settings.votingSeconds;
    case 'verdict':
      return VERDICT_SECONDS;
    default:
      return null;
  }
}

function beginPhase(state: VillageState, phase: VillagePhase, now: number): VillageState {
  const seconds = phaseSeconds(state.settings, phase);
  return {
    ...state,
    phase,
    phaseId: state.phaseId + 1,
    phaseStartedAt: iso(now),
    phaseEndsAt: seconds === null ? null : iso(now + seconds * 1000),
    pausedRemainingMs: null,
    chatSent: {},
    secret: { ...state.secret, packSent: {} },
  };
}

function beginNight(state: VillageState, now: number): VillageState {
  return beginPhase({ ...state, votes: {}, secret: { ...state.secret, night: {} } }, 'night', now);
}

/** What happens when the current phase is over — by the clock or the host. */
function endPhase(state: VillageState, now: number): VillageState {
  switch (state.phase) {
    case 'role_reveal':
      return beginNight(state, now);
    case 'night':
      return resolveNight(state, now);
    case 'dawn':
      return beginPhase(state, 'day', now);
    case 'day':
      return beginPhase({ ...state, votes: {} }, 'voting', now);
    case 'voting':
      return resolveVote(state, now);
    case 'verdict':
      return beginNight({ ...state, round: state.round + 1 }, now);
    default:
      return state;
  }
}

function timeout(state: VillageState, action: Action<'timeout'>, deps: ReducerDeps): VillageState {
  if (!isRunning(state.phase) || action.phaseId !== state.phaseId) return state;
  if (isPaused(state) || !state.phaseEndsAt) return state;
  const endsAt = Date.parse(state.phaseEndsAt);
  const now = deps.now();
  if (!Number.isFinite(endsAt) || now < endsAt - TIMEOUT_TOLERANCE_MS) return state;
  return endPhase(state, now);
}

function pause(state: VillageState, deps: ReducerDeps): VillageState {
  if (!isRunning(state.phase) || isPaused(state) || !state.phaseEndsAt) return state;
  const endsAt = Date.parse(state.phaseEndsAt);
  if (!Number.isFinite(endsAt)) return state;
  return { ...state, pausedRemainingMs: Math.max(0, endsAt - deps.now()), phaseEndsAt: null };
}

function resume(state: VillageState, deps: ReducerDeps): VillageState {
  if (!isRunning(state.phase) || state.pausedRemainingMs === null) return state;
  return {
    ...state,
    phaseEndsAt: iso(deps.now() + Math.max(1_000, state.pausedRemainingMs)),
    pausedRemainingMs: null,
  };
}

function extend(state: VillageState, action: Action<'extend'>, deps: ReducerDeps): VillageState {
  if (!isRunning(state.phase)) return state;
  const delta = action.seconds * 1000;
  if (state.pausedRemainingMs !== null) {
    return { ...state, pausedRemainingMs: Math.max(1_000, state.pausedRemainingMs + delta) };
  }
  if (!state.phaseEndsAt) return state;
  const endsAt = Date.parse(state.phaseEndsAt);
  if (!Number.isFinite(endsAt)) return state;
  const now = deps.now();
  return { ...state, phaseEndsAt: iso(Math.max(now + 1_000, endsAt + delta)) };
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function join(state: VillageState, action: Action<'join'>, deps: ReducerDeps): VillageState {
  void deps;
  const name = tidyText(action.name);
  if (name.length < 1 || name.length > NAME_MAX_LENGTH) return state;
  const id = action.playerId;

  if (state.phase !== 'lobby') {
    // Seats are fixed once the roles are dealt: late joiners watch.
    if (state.players.some((p) => p.id === id)) return state;
    return addSpectator(state, id, name);
  }

  const lower = name.toLowerCase();
  if (state.players.some((p) => p.id !== id && p.name.toLowerCase() === lower)) return state;

  const existing = state.players.find((p) => p.id === id);
  if (existing) {
    const color = isColor(action.color) ? action.color : existing.color;
    if (existing.name === name && existing.color === color) return state;
    return {
      ...state,
      players: state.players.map((p) => (p.id === id ? { ...p, name, color } : p)),
    };
  }

  if (state.players.length >= MAX_PLAYERS) return addSpectator(state, id, name);

  const seat = state.seq + 1;
  const player: VillagePlayer = {
    id,
    name,
    color: isColor(action.color) ? action.color : firstFreeColor(state.players),
    seat,
    ready: false,
    alive: true,
    death: null,
  };
  return {
    ...state,
    seq: seat,
    players: [...state.players, player],
    spectators: state.spectators.filter((s) => s.id !== id),
  };
}

function addSpectator(state: VillageState, id: string, name: string): VillageState {
  const existing = state.spectators.find((s) => s.id === id);
  if (existing) {
    if (existing.name === name) return state;
    return { ...state, spectators: state.spectators.map((s) => (s.id === id ? { id, name } : s)) };
  }
  if (state.spectators.length >= MAX_SPECTATORS) return state;
  return { ...state, spectators: [...state.spectators, { id, name }] };
}

function leave(state: VillageState, action: Action<'leave'>, deps: ReducerDeps): VillageState {
  const id = action.playerId;
  if (state.spectators.some((s) => s.id === id)) {
    return { ...state, spectators: state.spectators.filter((s) => s.id !== id) };
  }
  const player = state.players.find((p) => p.id === id);
  if (!player) return state;
  if (state.phase === 'lobby') return { ...state, players: state.players.filter((p) => p.id !== id) };
  if (!isRunning(state.phase) || !player.alive) return state;
  return eliminate(state, id, 'fled', deps.now());
}

function kick(state: VillageState, action: Action<'kick'>, deps: ReducerDeps): VillageState {
  const id = action.targetId;
  if (state.spectators.some((s) => s.id === id)) {
    return { ...state, spectators: state.spectators.filter((s) => s.id !== id) };
  }
  const player = state.players.find((p) => p.id === id);
  if (!player) return state;
  if (state.phase === 'lobby') return { ...state, players: state.players.filter((p) => p.id !== id) };
  if (!isRunning(state.phase) || !player.alive) return state;
  return eliminate(state, id, 'removed', deps.now());
}

function setReady(state: VillageState, action: Action<'set-ready'>): VillageState {
  if (state.phase !== 'lobby') return state;
  const player = state.players.find((p) => p.id === action.playerId);
  if (!player || player.ready === action.ready) return state;
  return {
    ...state,
    players: state.players.map((p) => (p.id === player.id ? { ...p, ready: action.ready } : p)),
  };
}

function configure(state: VillageState, action: Action<'configure'>): VillageState {
  const requested = action.settings as Record<string, unknown>;
  const next: VillageSettings = { ...state.settings };
  let changed = false;
  for (const key of Object.keys(SETTING_LIMITS) as Array<keyof VillageSettings>) {
    const value = requested[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const { min, max } = SETTING_LIMITS[key];
    const clamped = Math.min(max, Math.max(min, Math.round(value)));
    if (clamped !== next[key]) {
      next[key] = clamped;
      changed = true;
    }
  }
  return changed ? { ...state, settings: next } : state;
}

function start(state: VillageState, deps: ReducerDeps): VillageState {
  if (state.phase !== 'lobby') return state;
  const players = state.players;
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) return state;
  if (!players.every((p) => p.ready)) return state;

  const deck = shuffle(rolesForPlayerCount(players.length), deps.random);
  const roles: Record<string, VillageRole> = {};
  const resources: Record<string, VillageResources> = {};
  players.forEach((p, index) => {
    const role = deck[index]!;
    roles[p.id] = role;
    if (role === 'hunter') resources[p.id] = { bullets: HUNTER_BULLETS };
    if (role === 'survivor') resources[p.id] = { shields: SURVIVOR_SHIELDS };
    if (role === 'doctor') resources[p.id] = { lastProtectedId: null };
  });

  const now = deps.now();
  let next: VillageState = {
    ...state,
    round: 1,
    players: players.map((p) => ({ ...p, alive: true, death: null })),
    votes: {},
    chat: [],
    chatSent: {},
    log: [],
    jesterWinners: [],
    outcome: null,
    secret: { ...emptySecret(), roles, resources },
  };
  next = appendLog(
    next,
    { kind: 'game-start', players: players.length, vampires: deck.filter((r) => r === 'vampire').length },
    'setup',
    now
  );
  return beginPhase(next, 'role_reveal', now);
}

function playAgain(state: VillageState, deps: ReducerDeps): VillageState {
  if (state.phase !== 'ended') return state;
  return {
    ...createVillageInitialState(),
    settings: { ...state.settings },
    players: state.players.map((p) => ({ ...p, ready: false, alive: true, death: null })),
    spectators: state.spectators,
    seq: state.seq,
    phaseId: state.phaseId + 1,
    phaseStartedAt: iso(deps.now()),
  };
}

// ---------------------------------------------------------------------------
// Night
// ---------------------------------------------------------------------------

function canShoot(state: VillageState, resources: VillageResources): boolean {
  return state.round >= HUNTER_FIRST_NIGHT && (resources.bullets ?? 0) > 0;
}

/** The bite a majority of the living pack agrees on, if any. */
function agreedBite(state: VillageState, night: Record<string, VillageNightChoice>): string | null {
  const vampires = state.players.filter((p) => p.alive && roleOf(state, p.id) === 'vampire');
  if (vampires.length === 0) return null;
  const needed = majorityNeeded(vampires.length);
  const counts = new Map<string, number>();
  for (const vampire of vampires) {
    const choice = night[vampire.id];
    if (choice?.kind !== 'bite') continue;
    const target = livingPlayer(state, choice.targetId);
    if (!target || roleOf(state, target.id) === 'vampire') continue;
    counts.set(target.id, (counts.get(target.id) ?? 0) + 1);
  }
  for (const [target, votes] of counts) if (votes >= needed) return target;
  return null;
}

/** True once everyone with a night decision has made it (spec §9: the night ends early). */
function nightComplete(state: VillageState): boolean {
  const night = state.secret.night;
  const living = state.players.filter((p) => p.alive);
  if (living.some((p) => roleOf(state, p.id) === 'vampire') && agreedBite(state, night) === null) return false;
  for (const p of living) {
    const role = roleOf(state, p.id);
    const chose = night[p.id] !== undefined;
    if (chose) continue;
    if (role === 'seer' || role === 'doctor') return false;
    if (role === 'hunter' && canShoot(state, resourcesOf(state, p.id))) return false;
    if (role === 'survivor' && (resourcesOf(state, p.id).shields ?? 0) > 0) return false;
  }
  return true;
}

function withNightChoice(
  state: VillageState,
  playerId: string,
  choice: VillageNightChoice | null,
  now: number
): VillageState {
  const night = { ...state.secret.night };
  if (choice === null) {
    if (!(playerId in night)) return state;
    delete night[playerId];
  } else {
    night[playerId] = choice;
  }
  const next = { ...state, secret: { ...state.secret, night } };
  return nightComplete(next) ? resolveNight(next, now) : next;
}

function nightTarget(state: VillageState, action: Action<'night-target'>, deps: ReducerDeps): VillageState {
  if (state.phase !== 'night' || isPaused(state)) return state;
  const actor = livingPlayer(state, action.playerId);
  if (!actor) return state;
  const role = roleOf(state, actor.id);
  const resources = resourcesOf(state, actor.id);
  const targetId = action.targetId;

  // undefined = refused; null = withdraw the pack vote.
  let choice: VillageNightChoice | null | undefined;
  if (targetId === null) {
    if (role === 'vampire') choice = null;
    else if (role === 'seer' || role === 'doctor') choice = { kind: 'skip' };
    else if (role === 'hunter' && canShoot(state, resources)) choice = { kind: 'skip' };
  } else {
    const target = livingPlayer(state, targetId);
    if (!target) return state;
    if (role === 'vampire' && roleOf(state, target.id) !== 'vampire') choice = { kind: 'bite', targetId: target.id };
    else if (role === 'seer' && target.id !== actor.id) choice = { kind: 'inspect', targetId: target.id };
    else if (role === 'doctor' && target.id !== resources.lastProtectedId) choice = { kind: 'protect', targetId: target.id };
    else if (role === 'hunter' && canShoot(state, resources) && target.id !== actor.id) {
      choice = { kind: 'shoot', targetId: target.id };
    }
  }
  if (choice === undefined) return state;
  return withNightChoice(state, actor.id, choice, deps.now());
}

function nightShield(state: VillageState, action: Action<'night-shield'>, deps: ReducerDeps): VillageState {
  if (state.phase !== 'night' || isPaused(state)) return state;
  const actor = livingPlayer(state, action.playerId);
  if (!actor || roleOf(state, actor.id) !== 'survivor') return state;
  if ((resourcesOf(state, actor.id).shields ?? 0) <= 0) return state;
  return withNightChoice(state, actor.id, { kind: 'shield', raise: action.raise }, deps.now());
}

/**
 * Resolve the night in the spec §10 order (MVP roles):
 *   1. information — the seer
 *   2. protection  — the doctor, then the survivor's shield (spec step 6,
 *      applied up front: it only ever blocks)
 *   3. attacks     — the hunter's shot (5b), then the pack's bite (5c)
 *   4. results     — the hunter's remorse, private notes, the public log
 */
function resolveNight(state: VillageState, now: number): VillageState {
  const round = state.round;
  const living = state.players.filter((p) => p.alive);
  const alive = new Set(living.map((p) => p.id));
  const role = (id: string) => roleOf(state, id);

  // Only the living act; a choice left behind by someone who died tonight counts for nothing.
  const choices: Record<string, VillageNightChoice> = {};
  for (const [id, choice] of Object.entries(state.secret.night)) if (alive.has(id)) choices[id] = choice;

  const notes: Record<string, VillageNote[]> = { ...state.secret.notes };
  const addNote = (id: string, note: VillageNote) => {
    notes[id] = [...(notes[id] ?? []), note];
  };
  const resources: Record<string, VillageResources> = { ...state.secret.resources };

  // 1. Information.
  for (const p of living) {
    const choice = choices[p.id];
    if (role(p.id) !== 'seer' || choice?.kind !== 'inspect' || !alive.has(choice.targetId)) continue;
    const seen = role(choice.targetId);
    if (seen) addNote(p.id, { kind: 'inspected', round, targetId: choice.targetId, role: seen });
  }

  // 2. Protection.
  const guarded = new Set<string>();
  for (const p of living) {
    if (role(p.id) !== 'doctor') continue;
    const choice = choices[p.id];
    const patient = choice?.kind === 'protect' && alive.has(choice.targetId) ? choice.targetId : null;
    if (patient) guarded.add(patient);
    resources[p.id] = { ...resources[p.id], lastProtectedId: patient };
  }
  const shielded = new Set<string>();
  for (const p of living) {
    if (role(p.id) !== 'survivor') continue;
    const choice = choices[p.id];
    const shields = resources[p.id]?.shields ?? 0;
    if (choice?.kind === 'shield' && choice.raise && shields > 0) {
      shielded.add(p.id);
      resources[p.id] = { ...resources[p.id], shields: shields - 1 };
    }
  }

  // 3. Attacks.
  const attacks: Array<{ targetId: string; cause: 'shot' | 'bitten'; hunterId?: string }> = [];
  for (const p of living) {
    if (role(p.id) !== 'hunter') continue;
    const choice = choices[p.id];
    const gun = resources[p.id] ?? {};
    if (choice?.kind !== 'shoot' || !canShoot(state, gun) || !alive.has(choice.targetId) || choice.targetId === p.id) {
      continue;
    }
    resources[p.id] = { ...gun, bullets: (gun.bullets ?? 0) - 1 };
    attacks.push({ targetId: choice.targetId, cause: 'shot', hunterId: p.id });
  }
  const bite = agreedBite(state, choices);
  if (bite) attacks.push({ targetId: bite, cause: 'bitten' });

  const deaths = new Map<string, VillageDeathCause>();
  const attacked = new Set<string>();
  const saved = new Set<string>();
  let stopped = 0;
  const shots: Array<{ hunterId: string; targetId: string; blocked: boolean }> = [];
  for (const attack of attacks) {
    attacked.add(attack.targetId);
    const blocked = guarded.has(attack.targetId) || shielded.has(attack.targetId);
    if (blocked) {
      saved.add(attack.targetId);
      stopped += 1;
    } else if (!deaths.has(attack.targetId)) {
      deaths.set(attack.targetId, attack.cause);
    }
    if (attack.hunterId) shots.push({ hunterId: attack.hunterId, targetId: attack.targetId, blocked });
  }

  // 4. Results.
  for (const shot of shots) {
    const victimRole = role(shot.targetId);
    const remorse = !shot.blocked && victimRole !== undefined && teamOf(victimRole) === 'village';
    if (remorse && !deaths.has(shot.hunterId)) deaths.set(shot.hunterId, 'remorse');
    addNote(shot.hunterId, {
      kind: 'shot',
      round,
      targetId: shot.targetId,
      result: shot.blocked ? 'blocked' : 'killed',
      remorse,
    });
  }
  for (const p of living) {
    const choice = choices[p.id];
    if (role(p.id) === 'doctor' && choice?.kind === 'protect' && alive.has(choice.targetId)) {
      addNote(p.id, { kind: 'protected', round, targetId: choice.targetId, attacked: attacked.has(choice.targetId) });
    }
    if (shielded.has(p.id)) addNote(p.id, { kind: 'shielded', round, attacked: attacked.has(p.id) });
  }
  for (const p of living) if (saved.has(p.id) && !deaths.has(p.id)) addNote(p.id, { kind: 'survived', round });

  const died = living.filter((p) => deaths.has(p.id));
  let next: VillageState = {
    ...state,
    players: state.players.map((p) => {
      const cause = deaths.get(p.id);
      const dealt = role(p.id);
      return cause && dealt ? { ...p, alive: false, death: { round, time: 'night' as const, cause, role: dealt } } : p;
    }),
    secret: {
      ...state.secret,
      night: {},
      notes,
      resources,
      history: [
        ...state.secret.history,
        {
          round,
          choices,
          biteTargetId: bite,
          deaths: died.map((p) => ({ playerId: p.id, cause: deaths.get(p.id)! })),
          saved: living.filter((p) => saved.has(p.id) && !deaths.has(p.id)).map((p) => p.id),
        },
      ],
    },
  };

  if (died.length === 0) next = appendLog(next, { kind: 'quiet-night' }, 'night', now);
  for (const p of died) {
    const dealt = role(p.id);
    if (dealt) next = appendLog(next, { kind: 'death', playerId: p.id, cause: deaths.get(p.id)!, role: dealt }, 'night', now);
  }
  if (stopped > 0) next = appendLog(next, { kind: 'attack-stopped', count: stopped }, 'night', now);

  const result = winCheck(next);
  return result ? endGame(next, result.winner, result.reason, now) : beginPhase(next, 'dawn', now);
}

// ---------------------------------------------------------------------------
// Day
// ---------------------------------------------------------------------------

function everyoneVoted(state: VillageState): boolean {
  return state.players
    .filter((p) => p.alive)
    .every((p) => Object.prototype.hasOwnProperty.call(state.votes, p.id));
}

function vote(state: VillageState, action: Action<'vote'>, deps: ReducerDeps): VillageState {
  if (state.phase !== 'voting' || isPaused(state)) return state;
  const voter = livingPlayer(state, action.playerId);
  if (!voter) return state;
  const targetId = action.targetId;
  if (targetId !== null) {
    const target = livingPlayer(state, targetId);
    if (!target || target.id === voter.id) return state;
  }
  if (Object.prototype.hasOwnProperty.call(state.votes, voter.id) && state.votes[voter.id] === targetId) return state;
  const next = { ...state, votes: { ...state.votes, [voter.id]: targetId } };
  return everyoneVoted(next) ? resolveVote(next, deps.now()) : next;
}

/**
 * Hang whoever a majority of the living voted for (the design's rule —
 * see docs/VAMPIRE_VILLAGE.md). With a strict majority there can be no
 * tie; anything short of one hangs nobody.
 */
function resolveVote(state: VillageState, now: number): VillageState {
  const living = state.players.filter((p) => p.alive);
  const alive = new Set(living.map((p) => p.id));
  const needed = majorityNeeded(living.length);
  const votes: Record<string, string | null> = {};
  for (const [voter, target] of Object.entries(state.votes)) {
    if (alive.has(voter) && (target === null || alive.has(target))) votes[voter] = target;
  }
  const counts = new Map<string, number>();
  for (const target of Object.values(votes)) if (target) counts.set(target, (counts.get(target) ?? 0) + 1);
  let hangedId: string | null = null;
  for (const [target, count] of counts) if (count >= needed) hangedId = target;

  let next = appendLog(state, { kind: 'vote-result', votes, hangedId, needed }, 'day', now);
  const hangedRole = hangedId ? roleOf(state, hangedId) : undefined;
  if (hangedId && hangedRole) {
    const id = hangedId;
    next = {
      ...next,
      players: next.players.map((p) =>
        p.id === id ? { ...p, alive: false, death: { round: state.round, time: 'day' as const, cause: 'hanged' as const, role: hangedRole } } : p
      ),
    };
    next = appendLog(next, { kind: 'death', playerId: id, cause: 'hanged', role: hangedRole }, 'day', now);
    if (hangedRole === 'jester') {
      next = { ...next, jesterWinners: [...next.jesterWinners, id] };
      next = appendLog(next, { kind: 'jester-win', playerId: id }, 'day', now);
    }
  }
  const result = winCheck(next);
  return result ? endGame(next, result.winner, result.reason, now) : beginPhase(next, 'verdict', now);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const PUBLIC_CHAT_PHASES: ReadonlySet<VillagePhase> = new Set(['dawn', 'day', 'voting', 'verdict']);

function chat(state: VillageState, action: Action<'chat'>, deps: ReducerDeps): VillageState {
  const text = tidyText(action.text);
  if (!text || text.length > CHAT_MAX_LENGTH) return state;
  const author = state.players.find((p) => p.id === action.playerId);
  if (!author) return state;
  // By day the living talk; at night the village sleeps (spec §16); once
  // the game is over everyone who played may talk.
  if (state.phase !== 'ended' && !(PUBLIC_CHAT_PHASES.has(state.phase) && author.alive)) return state;
  const sent = state.chatSent[author.id] ?? 0;
  if (sent >= CHAT_PER_PHASE) return state;
  const id = state.seq + 1;
  const message: VillageChatMessage = { id, authorId: author.id, text, at: iso(deps.now()), phaseId: state.phaseId };
  return {
    ...state,
    seq: id,
    chat: appendMessage(state.chat, message, CHAT_KEEP),
    chatSent: { ...state.chatSent, [author.id]: sent + 1 },
  };
}

function packChat(state: VillageState, action: Action<'pack-chat'>, deps: ReducerDeps): VillageState {
  if (state.phase !== 'role_reveal' && state.phase !== 'night') return state;
  const text = tidyText(action.text);
  if (!text || text.length > CHAT_MAX_LENGTH) return state;
  const author = livingPlayer(state, action.playerId);
  if (!author || roleOf(state, author.id) !== 'vampire') return state;
  const sent = state.secret.packSent[author.id] ?? 0;
  if (sent >= PACK_CHAT_PER_PHASE) return state;
  // Its own counter, under `secret`: the public `seq` must not move, or
  // the gap in the next public id would count the whispers.
  const id = (state.secret.packSeq ?? 0) + 1;
  const message: VillageChatMessage = { id, authorId: author.id, text, at: iso(deps.now()), phaseId: state.phaseId };
  return {
    ...state,
    secret: {
      ...state.secret,
      packSeq: id,
      packChat: appendMessage(state.secret.packChat, message, PACK_CHAT_KEEP),
      packSent: { ...state.secret.packSent, [author.id]: sent + 1 },
    },
  };
}

// ---------------------------------------------------------------------------
// Deaths outside the night and the vote, and the end of the game
// ---------------------------------------------------------------------------

/** A living player leaves or is removed mid-game: they count as dead. */
function eliminate(state: VillageState, id: string, cause: VillageDeathCause, now: number): VillageState {
  const player = livingPlayer(state, id);
  const dealt = roleOf(state, id);
  if (!player || !dealt) return state;
  const time = timeOf(state.phase);
  const votes: Record<string, string | null> = {};
  for (const [voter, target] of Object.entries(state.votes)) if (voter !== id && target !== id) votes[voter] = target;
  const night: Record<string, VillageNightChoice> = {};
  for (const [actor, choice] of Object.entries(state.secret.night)) {
    if (actor === id || ('targetId' in choice && choice.targetId === id)) continue;
    night[actor] = choice;
  }
  let next: VillageState = {
    ...state,
    votes,
    players: state.players.map((p) =>
      p.id === id ? { ...p, alive: false, death: { round: state.round, time, cause, role: dealt } } : p
    ),
    secret: { ...state.secret, night },
  };
  next = appendLog(next, { kind: 'death', playerId: id, cause, role: dealt }, time, now);

  const result = winCheck(next);
  if (result) return endGame(next, result.winner, result.reason, now);
  if (!isPaused(next) && next.phase === 'night' && nightComplete(next)) return resolveNight(next, now);
  if (!isPaused(next) && next.phase === 'voting' && everyoneVoted(next)) return resolveVote(next, now);
  return next;
}

/**
 * Spec §12: the village wins when no vampire is left; the vampires win
 * once they are at least as many as the living VILLAGE TEAM (neutrals do
 * not count). If both sides are gone at once, no team wins.
 */
function winCheck(state: VillageState): { winner: VillageWinner; reason: VillageEndReason } | null {
  const living = state.players.filter((p) => p.alive);
  let vampires = 0;
  let village = 0;
  for (const p of living) {
    const role = roleOf(state, p.id);
    if (!role) continue;
    if (role === 'vampire') vampires += 1;
    else if (teamOf(role) === 'village') village += 1;
  }
  if (vampires === 0) return village > 0 ? { winner: 'village', reason: 'vampires-gone' } : { winner: null, reason: 'no-team-left' };
  if (vampires >= village) return { winner: 'vampires', reason: 'vampires-parity' };
  return null;
}

/** The winning team (dead members too), a survivor still standing, and any hanged jester. */
function winnersOf(state: VillageState, winner: VillageWinner): string[] {
  const out: string[] = [];
  const bySeat = [...state.players].sort((a, b) => a.seat - b.seat);
  const team = winner === 'village' ? 'village' : winner === 'vampires' ? 'vampires' : null;
  if (team) {
    for (const p of bySeat) {
      const role = roleOf(state, p.id);
      if (role && teamOf(role) === team) out.push(p.id);
    }
  }
  for (const p of bySeat) if (p.alive && roleOf(state, p.id) === 'survivor' && !out.includes(p.id)) out.push(p.id);
  for (const id of state.jesterWinners) if (!out.includes(id)) out.push(id);
  return out;
}

function endGame(state: VillageState, winner: VillageWinner, reason: VillageEndReason, now: number): VillageState {
  const winners = reason === 'host-ended' ? [] : winnersOf(state, winner);
  const time: VillageTime = isRunning(state.phase) ? timeOf(state.phase) : 'day';
  const ended: VillageState = {
    ...state,
    phase: 'ended',
    phaseId: state.phaseId + 1,
    phaseStartedAt: iso(now),
    phaseEndsAt: null,
    pausedRemainingMs: null,
    chatSent: {},
    outcome: { winner, reason, winners },
  };
  return appendLog(ended, { kind: 'game-over', winner, reason }, time, now);
}
