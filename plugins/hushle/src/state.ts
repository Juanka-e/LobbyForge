/**
 * Hushle game state and action model.
 *
 * The plugin is a server-authoritative reducer: the web app's room page
 * sends every action through the activity dispatch route, the host
 * `handleAction` is the only thing that produces the next state, and the
 * persisted state is the source of truth for every other participant's view.
 *
 * Phases:
 *   - lobby      : no game yet. The host picks a pack and the settings.
 *   - team_setup : the host is building the teams.
 *   - playing    : a turn runs while `timer.startedAt` is set; between two
 *                  turns the phase stays `playing` with the timer cleared.
 *   - ended      : the game is over; only scores are valid.
 *
 * State versioning:
 *
 *   Every persisted `HushleState` carries a `version` integer. When the
 *   state shape changes (new fields, renamed fields, removed fields),
 *   bump `HUSHLE_STATE_VERSION` and add a step to `migrateHushleState`
 *   below that upgrades the previous version. The host runs the
 *   migrator on every read so a server upgrade doesn't crash on
 *   sessions persisted by an older build. The reducer itself only
 *   ever produces `HUSHLE_STATE_VERSION`; older versions only exist
 *   in the database.
 */

import { cursorAfter } from './rotation';

export type HushlePhase = 'lobby' | 'team_setup' | 'playing' | 'ended';

/**
 * Card language. The two built-in packs ship `en` and `tr`, but hosts
 * can create packs in any language via the admin panel (M20b). The
 * `(string & {})` intersection keeps IDE autocomplete for the known
 * codes while accepting arbitrary BCP-47-ish tags (e.g. `de`, `pt-BR`).
 */
export type HushleLanguage = 'en' | 'tr' | (string & {});

/**
 * Difficulty tiers for a Hushle card. The visual treatment (color +
 * top-right pips) is plugin-owned; the reducer only knows the label.
 */
export type HushleDifficulty = 'easy' | 'medium' | 'hard';

export interface HushleCard {
  id: string;
  language: HushleLanguage;
  word: string;
  forbiddenWords: string[];
  difficulty: HushleDifficulty;
  category?: string;
}

export interface HushleTeam {
  id: string;
  name: string;
  playerIds: string[];
  score: number;
  correctCount: number;
  passCount: number;
  penaltyCount: number;
  /**
   * v3 — where this team's explainer rotation stands: the slot in its
   * rotation (see `rotation.ts`) that the team's NEXT turn goes to. It
   * moves on by one each time the team's turn starts; an explainer the
   * host picks by hand moves it to the slot after theirs.
   */
  nextExplainerSlot: number;
}

export interface HushleSettings {
  turnDurationSeconds: number;
  cardsPerTurn: number;
  language: HushleLanguage;
  packId: string | null;
  /**
   * Target number of players per team. `set-teams` trims every team to
   * it. Hushle defaults to 2 (the 2v2 format); an odd player count
   * carries the extra player as `floaterPlayerId`.
   */
  teamSize: number;
  /**
   * Weighted draw distribution. Keys are HushleDifficulty; values are
   * fractions in [0, 1] that sum to 1. Default is
   * `{ easy: 0.6, medium: 0.3, hard: 0.1 }`. The reducer samples a tier,
   * then draws an unused card from that tier's bucket.
   */
  difficultyDistribution: Record<HushleDifficulty, number>;
}

/**
 * The turn timer. A turn has ONE clock: it starts with the turn and does
 * not restart per card, so the explaining team gets the whole duration for
 * as many cards as they manage. `endsAt` is the deadline every client
 * counts down to; after it, the turn's scoring is over.
 */
export interface HushleTimer {
  startedAt: string | null;
  durationSeconds: number;
  paused: boolean;
  /** v3 — when the running turn's time is up (ISO). Null between turns. */
  endsAt: string | null;
}

export interface HushleState {
  version: number;
  phase: HushlePhase;
  teams: HushleTeam[];
  /**
   * The extra player of an odd player count. They sit on no team; they
   * have a slot in EVERY team's explainer rotation instead, so they
   * explain once for each team per round.
   */
  floaterPlayerId: string | null;
  /** v3 — the current turn's number, 1 for the first; 0 before play starts. */
  turnNumber: number;
  currentTeamId: string | null;
  currentExplainerId: string | null;
  currentCard: HushleCard | null;
  deck: HushleCard[];
  deckIndex: number;
  /**
   * Card IDs already drawn this game. The reducer consults this set when
   * sampling from a difficulty tier to avoid repeating the same card.
   * Resets to `[]` on `start-game`.
   *
   * beta-review: SERVER ONLY. These are stable DB card ids and the last
   * entry is the current card, so the canonical projector
   * (@lobbyforge/core) replaces them with `usedCardCount` for every
   * viewer — the client must not rely on this field.
   */
  usedCardIds: string[];
  settings: HushleSettings;
  timer: HushleTimer;
  cardsPlayedThisTurn: number;
  totalCardsPlayed: number;
  createdBy: string | null;
  createdAt: string | null;
}

export type HushleAction =
  | {
      type: 'start-game';
      packId: string;
      language?: HushleLanguage;
      turnDurationSeconds?: number;
      createdBy: string;
      /** Optional difficulty weights and team size; default 60/30/10 and 2. */
      difficultyDistribution?: Partial<Record<HushleDifficulty, number>>;
      teamSize?: number;
      /**
       * Cards per turn before the turn ends. Defaults to
       * `HUSHLE_DEFAULT_CARDS_PER_TURN` (15).
       */
      cardsPerTurn?: number;
      /** Host-injected DB deck. Client input is overwritten at the API boundary. */
      deck?: HushleCard[];
    }
  | {
      type: 'set-teams';
      teams: Array<{ name: string; playerIds: string[] }>;
      /** The single extra player of an odd count, or null (the default). */
      floaterPlayerId?: string | null;
    }
  | { type: 'start-turn'; teamId: string; explainerId: string | null }
  | { type: 'set-explainer'; explainerId: string | null }
  | { type: 'next-card' }
  | { type: 'correct-guess' }
  | { type: 'pass' }
  | { type: 'penalty' }
  /**
   * Classic-Taboo buzzer: a player on an OPPOSING team catches the
   * explainer saying a forbidden word and presses BUST. Server injects
   * the actor id via actionPolicies `actorFields` — the reducer then
   * verifies the caller really is on another team (teammates and the
   * floater cannot bust their own explainer). Applies the standard
   * penalty (-1 to the explaining team) and draws the next card.
   *
   * `cardId` is the card the buster saw: a BUST for any card but the one
   * on screen is ignored, so two opponents pressing at once (or one
   * double-tap) cost ONE penalty and never burn the next card.
   */
  | { type: 'bust-forbidden'; bustedBy?: string; cardId?: string }
  | { type: 'end-turn' }
  | { type: 'end-game' };

export const HUSHLE_DEFAULT_TURN_DURATION_SECONDS = 60;
export const HUSHLE_DEFAULT_CARDS_PER_TURN = 15;
export const HUSHLE_DEFAULT_TEAM_SIZE = 2;
export const HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION: Record<HushleDifficulty, number> = {
  easy: 0.6,
  medium: 0.3,
  hard: 0.1,
};

/**
 * How late a card may still be scored after the turn's deadline: the time
 * a host's last-second tap takes to reach the server. Past it, the turn's
 * scoring is over.
 */
export const HUSHLE_TIME_UP_GRACE_MS = 2000;

/**
 * The current Hushle state schema version. Bump this and add a step
 * to `migrateHushleState` below whenever the state shape changes in
 * a backwards-incompatible way.
 *
 * v2 (M20a) added the floater, the difficulty tiers and the weighted draw.
 * v3 gives every team its own explainer rotation (`teams[].nextExplainerSlot`,
 * replacing the single `currentExplainerIndex`), counts turns
 * (`turnNumber`) and keeps the turn's deadline (`timer.endsAt`).
 */
export const HUSHLE_STATE_VERSION = 3;

export function createHushleInitialState(): HushleState {
  return {
    version: HUSHLE_STATE_VERSION,
    phase: 'lobby',
    teams: [],
    floaterPlayerId: null,
    turnNumber: 0,
    currentTeamId: null,
    currentExplainerId: null,
    currentCard: null,
    deck: [],
    deckIndex: 0,
    usedCardIds: [],
    settings: {
      turnDurationSeconds: HUSHLE_DEFAULT_TURN_DURATION_SECONDS,
      cardsPerTurn: HUSHLE_DEFAULT_CARDS_PER_TURN,
      language: 'en',
      packId: null,
      teamSize: HUSHLE_DEFAULT_TEAM_SIZE,
      difficultyDistribution: { ...HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION },
    },
    timer: {
      startedAt: null,
      durationSeconds: HUSHLE_DEFAULT_TURN_DURATION_SECONDS,
      paused: true,
      endsAt: null,
    },
    cardsPlayedThisTurn: 0,
    totalCardsPlayed: 0,
    createdBy: null,
    createdAt: null,
  };
}

// ---------------------------------------------------------------------------
// Migrations. Older shapes are handled as loose records: each step takes the
// previous version's shape and returns the next one's.
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

const asRecord = (value: unknown): Loose =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {};

/** The v2 defaults — the shape v0 and v1 rows are brought up to first. */
const HUSHLE_V2_DEFAULTS: Loose = {
  phase: 'lobby',
  teams: [],
  floaterPlayerId: null,
  currentExplainerIndex: 0,
  currentTeamId: null,
  currentExplainerId: null,
  currentCard: null,
  deck: [],
  deckIndex: 0,
  usedCardIds: [],
  settings: {
    turnDurationSeconds: HUSHLE_DEFAULT_TURN_DURATION_SECONDS,
    cardsPerTurn: HUSHLE_DEFAULT_CARDS_PER_TURN,
    language: 'en',
    packId: null,
    teamSize: HUSHLE_DEFAULT_TEAM_SIZE,
    difficultyDistribution: { ...HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION },
  },
  timer: {
    startedAt: null,
    durationSeconds: HUSHLE_DEFAULT_TURN_DURATION_SECONDS,
    paused: true,
  },
  cardsPlayedThisTurn: 0,
  totalCardsPlayed: 0,
  createdBy: null,
  createdAt: null,
};

function migrateV0ToV1(raw: unknown): Loose {
  // Pre-versioned state had no `version` field. Promote it to v1 with
  // defaults for any fields added in v1. The reducer's view of the
  // data is unchanged — `phase` / `teams` / `deck` already existed.
  const base = asRecord(raw);
  return {
    ...HUSHLE_V2_DEFAULTS,
    ...base,
    version: 1,
    // settings was already in v0 but the schema may have drifted; merge
    // defaults so a partially-shaped row still loads.
    settings: { ...asRecord(HUSHLE_V2_DEFAULTS.settings), ...asRecord(base.settings) },
    timer: { ...asRecord(HUSHLE_V2_DEFAULTS.timer), ...asRecord(base.timer) },
  };
}

function migrateV1ToV2(raw: unknown): Loose {
  // v1 had no `difficulty` on cards, no floater support, no
  // `teamSize` / `difficultyDistribution` on settings, no `usedCardIds`.
  // Promote every card to `easy` (the safest default).
  const base = asRecord(raw);
  const toCard = (value: unknown) => {
    const c = asRecord(value);
    return {
      id: typeof c.id === 'string' ? c.id : 'card-migrated',
      language: c.language === 'tr' ? 'tr' : 'en',
      word: typeof c.word === 'string' ? c.word : '',
      forbiddenWords: Array.isArray(c.forbiddenWords)
        ? (c.forbiddenWords as unknown[]).filter((w): w is string => typeof w === 'string')
        : [],
      difficulty: 'easy',
    };
  };
  const deck = Array.isArray(base.deck) ? (base.deck as unknown[]).map(toCard) : [];
  const currentCard = base.currentCard && typeof base.currentCard === 'object' ? toCard(base.currentCard) : null;
  return {
    ...HUSHLE_V2_DEFAULTS,
    ...base,
    version: 2,
    floaterPlayerId: null,
    currentExplainerIndex: 0,
    usedCardIds: [],
    deck,
    currentCard,
    settings: {
      ...asRecord(HUSHLE_V2_DEFAULTS.settings),
      ...asRecord(base.settings),
      teamSize: HUSHLE_DEFAULT_TEAM_SIZE,
      difficultyDistribution: { ...HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION },
    },
    timer: { ...asRecord(HUSHLE_V2_DEFAULTS.timer), ...asRecord(base.timer) },
  };
}

function migrateV2ToV3(raw: unknown): HushleState {
  // v2 had one rotation index for all teams (`currentExplainerIndex`), a
  // timer that restarted with every card, and no turn counter. v3 gives
  // every team its own rotation cursor, numbers the turns, and keeps the
  // turn's deadline.
  const { currentExplainerIndex, ...base } = asRecord(raw);
  const oldIndex = typeof currentExplainerIndex === 'number' ? Math.max(0, Math.floor(currentExplainerIndex)) : 0;
  const teams = (Array.isArray(base.teams) ? (base.teams as unknown[]) : []).map((value) => {
    const team = asRecord(value);
    return {
      ...team,
      nextExplainerSlot: typeof team.nextExplainerSlot === 'number' ? team.nextExplainerSlot : 0,
    } as unknown as HushleTeam;
  });

  const timer = asRecord(base.timer);
  const startedAt = typeof timer.startedAt === 'string' ? timer.startedAt : null;
  const durationSeconds =
    typeof timer.durationSeconds === 'number' ? timer.durationSeconds : HUSHLE_DEFAULT_TURN_DURATION_SECONDS;
  const paused = timer.paused === true;
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const endsAt =
    startedAt && !paused && Number.isFinite(start) ? new Date(start + durationSeconds * 1000).toISOString() : null;

  const inPlay = (base.phase === 'playing' || base.phase === 'ended') && typeof base.currentTeamId === 'string';
  const state = {
    ...(base as unknown as HushleState),
    version: HUSHLE_STATE_VERSION,
    teams,
    turnNumber: inPlay ? oldIndex + 1 : 0,
    timer: { startedAt, durationSeconds, paused, endsAt },
  };

  // A game in progress: the explaining team's rotation continues after
  // whoever explains now. The other teams start their rotation afresh.
  if (inPlay) {
    const index = teams.findIndex((team) => team.id === base.currentTeamId);
    const explainer = typeof base.currentExplainerId === 'string' ? base.currentExplainerId : null;
    const cursor = index === -1 ? null : cursorAfter(state, index, explainer);
    if (cursor !== null) {
      state.teams = teams.map((team, i) => (i === index ? { ...team, nextExplainerSlot: cursor } : team));
    }
  }
  return state;
}

/**
 * Migrate an arbitrary JSONB blob (the persisted `state` column on
 * `game_sessions`) to the current `HushleState`. Idempotent — running
 * twice produces the same result. Defensive: an invalid blob (null,
 * missing phase, etc.) falls back to `createHushleInitialState()` so
 * the host never crashes on a bad row.
 */
export function migrateHushleState(raw: unknown): HushleState {
  if (!raw || typeof raw !== 'object') {
    return createHushleInitialState();
  }
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.version === 'number' ? obj.version : 0;
  if (version === HUSHLE_STATE_VERSION) {
    return raw as HushleState;
  }
  // Walk the chain forward from the row's version to current. Each
  // step is a pure transform; `state` is small enough that the cost
  // is negligible compared to the read round-trip.
  let state: unknown = raw;
  if (version < 1) state = migrateV0ToV1(state);
  if (version < 2) state = migrateV1ToV2(state);
  if (version < 3) state = migrateV2ToV3(state);
  // if (version < 4) state = migrateV3ToV4(state);   ← add when v4 lands
  return state as HushleState;
}
