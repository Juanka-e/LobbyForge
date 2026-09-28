/**
 * Vampire Village — state and action model.
 *
 * The plugin is a server-authoritative reducer (see `reducer.ts`): every
 * action goes through the host's activity route, the reducer produces the
 * next state, and the host persists it. The persisted state holds SECRETS
 * (who is a vampire, what the seer learned, the pack's chat), so it never
 * reaches a client as-is: `@lobbyforge/core`'s `projectActivityState`
 * turns it into a per-viewer `VillageView` (see `view.ts`).
 *
 * Layout rule that keeps the projection simple and safe: everything
 * secret lives under `state.secret`. The projection removes that whole
 * object and hands each viewer only their own slice as `me`. A new secret
 * field added under `secret` is therefore hidden by default.
 *
 * Phases (spec §9, MVP):
 *
 *   lobby → role_reveal → night → dawn → day → voting → verdict → night …
 *                                    ↘ ended (a side has won)       ↗
 *
 * `verdict` is the spec's `execution` step (the hanging and its result).
 * `last_words` is Phase 2 and not modelled.
 */

export type VillagePhase =
  | 'lobby'
  | 'role_reveal'
  | 'night'
  | 'dawn'
  | 'day'
  | 'voting'
  | 'verdict'
  | 'ended';

/** The MVP roles (spec §23). */
export type VillageRole = 'vampire' | 'villager' | 'seer' | 'doctor' | 'hunter' | 'survivor' | 'jester';

export type VillageTeam = 'vampires' | 'village' | 'neutral';

/**
 * How someone left the game. `remorse` is the hunter's guilt death (spec
 * §7: shooting an innocent villager kills the hunter too); `fled` and
 * `removed` are a player leaving and the host removing them.
 */
export type VillageDeathCause = 'bitten' | 'shot' | 'remorse' | 'hanged' | 'fled' | 'removed';

/** When something happened: before the first night, at night, or by day. */
export type VillageTime = 'setup' | 'night' | 'day';

/** Card colours a player can pick for their character (spec §6). */
export const PLAYER_COLORS = ['rose', 'amber', 'ice', 'mint', 'violet', 'coral', 'sky', 'sand'] as const;
export type VillageColor = (typeof PLAYER_COLORS)[number];

export interface VillageDeath {
  round: number;
  time: 'night' | 'day';
  cause: VillageDeathCause;
  /** Public from the moment of death (spec §13: the dead card shows the role). */
  role: VillageRole;
}

export interface VillagePlayer {
  id: string;
  /** Character name, unique in the village (spec §6). */
  name: string;
  color: VillageColor;
  /** Join order; never reused, so it is a stable sort key. */
  seat: number;
  /** Lobby readiness. */
  ready: boolean;
  alive: boolean;
  death: VillageDeath | null;
}

/** Someone watching who holds no seat: joined late, or the lobby was full. */
export interface VillageSpectator {
  id: string;
  name: string;
}

export interface VillageChatMessage {
  id: number;
  authorId: string;
  text: string;
  at: string;
  phaseId: number;
}

export interface VillageSettings {
  nightSeconds: number;
  daySeconds: number;
  votingSeconds: number;
}

interface LogBase {
  id: number;
  round: number;
  time: VillageTime;
  at: string;
}

/**
 * The public event log (spec §14). Structured, not prose, so every
 * viewer reads it in their own language. Nothing secret goes in here —
 * night actions are only revealed through `secret.history` at the end.
 */
export type VillageLogEntry = LogBase &
  (
    | { kind: 'game-start'; players: number; vampires: number }
    | { kind: 'death'; playerId: string; cause: VillageDeathCause; role: VillageRole }
    | { kind: 'quiet-night' }
    | { kind: 'attack-stopped'; count: number }
    | { kind: 'vote-result'; votes: Record<string, string | null>; hangedId: string | null; needed: number }
    | { kind: 'jester-win'; playerId: string }
    | { kind: 'game-over'; winner: VillageWinner; reason: VillageEndReason }
  );

/** What one player chose tonight. The latest choice counts until the night ends. */
export type VillageNightChoice =
  | { kind: 'bite'; targetId: string }
  | { kind: 'inspect'; targetId: string }
  | { kind: 'protect'; targetId: string }
  | { kind: 'shoot'; targetId: string }
  | { kind: 'shield'; raise: boolean }
  | { kind: 'skip' };

/** Something only one player learns (spec §14: night actions stay private). */
export type VillageNote = { round: number } & (
  | { kind: 'inspected'; targetId: string; role: VillageRole }
  | { kind: 'protected'; targetId: string; attacked: boolean }
  | { kind: 'survived' }
  | { kind: 'shot'; targetId: string; result: 'killed' | 'blocked'; remorse: boolean }
  | { kind: 'shielded'; attacked: boolean }
);

/** Per-player role resources: the hunter's bullets, the survivor's shields, the doctor's memory. */
export interface VillageResources {
  bullets?: number;
  shields?: number;
  lastProtectedId?: string | null;
}

export interface VillageNightRecord {
  round: number;
  choices: Record<string, VillageNightChoice>;
  biteTargetId: string | null;
  deaths: Array<{ playerId: string; cause: VillageDeathCause }>;
  saved: string[];
}

/** SERVER ONLY until the game ends. The projection strips it for every viewer. */
export interface VillageSecret {
  roles: Record<string, VillageRole>;
  /** Tonight's choices, by player. */
  night: Record<string, VillageNightChoice>;
  notes: Record<string, VillageNote[]>;
  resources: Record<string, VillageResources>;
  packChat: VillageChatMessage[];
  /** Pack messages sent this phase, by vampire (the per-phase cap). */
  packSent: Record<string, number>;
  /**
   * Id counter for pack messages. Kept apart from the public `seq`: a
   * whisper must not leave a gap in the public log/chat ids, or anyone
   * could count the pack's messages (and time them). Optional so a state
   * written before it existed still reads as 0.
   */
  packSeq?: number;
  /** Every resolved night, for the end-of-game timeline. */
  history: VillageNightRecord[];
}

export type VillageWinner = 'village' | 'vampires' | null;

export type VillageEndReason = 'vampires-gone' | 'vampires-parity' | 'no-team-left' | 'host-ended';

export interface VillageOutcome {
  winner: VillageWinner;
  reason: VillageEndReason;
  /** Everyone who won: the winning team (alive or dead), a surviving survivor, a hanged jester. */
  winners: string[];
}

export interface VillageState {
  version: number;
  phase: VillagePhase;
  /** Night/day number, from 1 once the game starts. */
  round: number;
  /** Bumped on every phase change; a timeout or advance names the phase it ends. */
  phaseId: number;
  phaseStartedAt: string | null;
  /** Deadline of the current phase (ISO), or null when untimed or paused. */
  phaseEndsAt: string | null;
  /** Set while the host has paused the game. */
  pausedRemainingMs: number | null;
  settings: VillageSettings;
  players: VillagePlayer[];
  spectators: VillageSpectator[];
  /** Today's votes by voter; null is "no one". Public (spec §14). */
  votes: Record<string, string | null>;
  chat: VillageChatMessage[];
  /** Public messages sent this phase, by player (the per-phase cap). */
  chatSent: Record<string, number>;
  log: VillageLogEntry[];
  /** Jesters the village hanged — they have already won (spec §7). */
  jesterWinners: string[];
  outcome: VillageOutcome | null;
  /**
   * Id counter for PUBLIC things only: seats, log entries, village chat.
   * Anything secret counts elsewhere (`secret.packSeq`) — a secret write
   * that bumped this would show up as a gap in the public ids.
   */
  seq: number;
  secret: VillageSecret;
}

export type VillageAction =
  | { type: 'join'; playerId: string; name: string; color?: string }
  | { type: 'leave'; playerId: string }
  | { type: 'set-ready'; playerId: string; ready: boolean }
  | { type: 'configure'; settings: Partial<VillageSettings> }
  | { type: 'start' }
  | { type: 'kick'; targetId: string }
  | { type: 'advance'; phaseId: number }
  | { type: 'timeout'; playerId: string; phaseId: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'extend'; seconds: number }
  | { type: 'night-target'; playerId: string; targetId: string | null }
  | { type: 'night-shield'; playerId: string; raise: boolean }
  | { type: 'vote'; playerId: string; targetId: string | null }
  | { type: 'chat'; playerId: string; text: string }
  | { type: 'pack-chat'; playerId: string; text: string }
  | { type: 'play-again' }
  | { type: 'end-game' };

export const VV_STATE_VERSION = 1;

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 12;
export const MAX_SPECTATORS = 50;
export const NAME_MAX_LENGTH = 24;
export const CHAT_MAX_LENGTH = 200;
/** Public chat: messages kept, and messages per player per phase. */
export const CHAT_KEEP = 60;
export const CHAT_PER_PHASE = 10;
/** Pack chat: messages kept, and whispers per vampire per phase. */
export const PACK_CHAT_KEEP = 40;
export const PACK_CHAT_PER_PHASE = 12;
export const LOG_KEEP = 200;

/** Spec §5 defaults. */
export const DEFAULT_VILLAGE_SETTINGS: VillageSettings = {
  nightSeconds: 30,
  daySeconds: 90,
  votingSeconds: 30,
};

export const SETTING_LIMITS: Record<keyof VillageSettings, { min: number; max: number }> = {
  nightSeconds: { min: 15, max: 180 },
  daySeconds: { min: 30, max: 600 },
  votingSeconds: { min: 15, max: 180 },
};

export function emptySecret(): VillageSecret {
  return { roles: {}, night: {}, notes: {}, resources: {}, packChat: [], packSent: {}, packSeq: 0, history: [] };
}

export function createVillageInitialState(): VillageState {
  return {
    version: VV_STATE_VERSION,
    phase: 'lobby',
    round: 0,
    phaseId: 0,
    phaseStartedAt: null,
    phaseEndsAt: null,
    pausedRemainingMs: null,
    settings: { ...DEFAULT_VILLAGE_SETTINGS },
    players: [],
    spectators: [],
    votes: {},
    chat: [],
    chatSent: {},
    log: [],
    jesterWinners: [],
    outcome: null,
    seq: 0,
    secret: emptySecret(),
  };
}

const PHASES: ReadonlySet<string> = new Set([
  'lobby',
  'role_reveal',
  'night',
  'dawn',
  'day',
  'voting',
  'verdict',
  'ended',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A structurally complete v1 state — enough for the reducer never to trip over it. */
function isCurrentState(raw: unknown): raw is VillageState {
  if (!isRecord(raw) || raw.version !== VV_STATE_VERSION) return false;
  if (typeof raw.phase !== 'string' || !PHASES.has(raw.phase)) return false;
  if (typeof raw.round !== 'number' || typeof raw.phaseId !== 'number' || typeof raw.seq !== 'number') return false;
  for (const key of ['players', 'spectators', 'chat', 'log', 'jesterWinners'] as const) {
    if (!Array.isArray(raw[key])) return false;
  }
  for (const key of ['settings', 'votes', 'chatSent'] as const) {
    if (!isRecord(raw[key])) return false;
  }
  const secret = raw.secret;
  if (!isRecord(secret)) return false;
  for (const key of ['roles', 'night', 'notes', 'resources', 'packSent'] as const) {
    if (!isRecord(secret[key])) return false;
  }
  return Array.isArray(secret.packChat) && Array.isArray(secret.history);
}

/**
 * The migration seam (docs/PLUGIN_SDK.md → "State versioning"). v1 is the
 * first real shape; anything else — including the old werewolf stub,
 * which was never registered, so no real game can be lost — becomes a
 * fresh lobby. Idempotent: a current state is returned as the same object.
 *
 * When the shape changes: bump VV_STATE_VERSION and add a v1 → v2 step
 * here instead of resetting.
 */
export function migrateVillageState(raw: unknown): VillageState {
  if (isCurrentState(raw)) return raw;
  return createVillageInitialState();
}
