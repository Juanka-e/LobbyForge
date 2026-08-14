/**
 * Hushle game state and action model.
 *
 * The plugin is a server-authoritative reducer: the web app's room page
 * sends every action through the activity dispatch route, the host
 * `handleAction` is the only thing that produces the next state, and the
 * persisted state is the source of truth for every other participant's view.
 *
 * Phases:
 *   - lobby      : no game yet. Host can pick a language.
 *   - team_setup : language is picked, host is configuring teams.
 *   - playing    : a team's turn is in progress. Timer is running.
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
 * top-right icon) is plugin-owned; the reducer only knows the label.
 * M20a — the M17 reducer had no notion of difficulty.
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
}

export interface HushleSettings {
  turnDurationSeconds: number;
  cardsPerTurn: number;
  language: HushleLanguage;
  packId: string | null;
  /**
   * Target number of players per team. The reducer uses this to
   * validate `set-teams` and to drive the explainer rotation. Hushle
   * defaults to 2 (the 2v2 format); odd-player games carry the
   * extra player as a `floaterPlayerId` on state.
   */
  teamSize: number;
  /**
   * Weighted draw distribution. Keys are HushleDifficulty; values are
   * fractions in [0, 1] that sum to 1. Default is
   * `{ easy: 0.6, medium: 0.3, hard: 0.1 }` — 60% easy / 30% medium /
   * 10% hard. Server owners can override per session via the start
   * action. The reducer samples a tier by `pickDifficultyTier`, then
   * draws a card from that tier's bucket.
   */
  difficultyDistribution: Record<HushleDifficulty, number>;
}

export interface HushleTimer {
  startedAt: string | null;
  durationSeconds: number;
  paused: boolean;
}

export interface HushleState {
  version: number;
  phase: HushlePhase;
  teams: HushleTeam[];
  /**
   * M20a — odd-player support. When the player count isn't divisible
   * by `settings.teamSize * 2`, the host passes a single extra player
   * via `set-teams` (or as a `floaterPlayerId`). The floater explains
   * for whichever team's turn it is on alternating turns — across a
   * 4-turn round, the floater ends up explaining twice. The reducer
   * carries the floater on state so `end-turn`'s auto-rotation can
   * pick the right explainer without the host passing it explicitly.
   */
  floaterPlayerId: string | null;
  /**
   * M20a — index into the flattened explainer rotation. The reducer
   * uses this to auto-pick the next explainer on `end-turn`. Stored
   * on state so the host doesn't have to recompute the rotation
   * from scratch on every turn. Resets to 0 when `set-teams` runs.
   */
  currentExplainerIndex: number;
  currentTeamId: string | null;
  currentExplainerId: string | null;
  currentCard: HushleCard | null;
  deck: HushleCard[];
  deckIndex: number;
  /**
   * Card IDs already drawn this game. The reducer consults this set
   * (in addition to the deck index) when sampling from a difficulty
   * tier to avoid repeating the same card. Resets to `[]` on
   * `set-teams` / `start-game`.
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
      /**
       * M20a — optional server-configured difficulty distribution and
       * team size. Both default to the Hushle MVP defaults (60/30/10
       * and teamSize 2). Server owners override at start-game time.
       */
      difficultyDistribution?: Partial<Record<HushleDifficulty, number>>;
      teamSize?: number;
      /**
       * M20a — cards per turn before the turn auto-rotates to the
       * next team. Defaults to `HUSHLE_DEFAULT_CARDS_PER_TURN` (15).
       * Tests override this to draw the whole deck without the
       * turn-ending mid-session.
       */
      cardsPerTurn?: number;
      /** Host-injected DB deck. Client input is overwritten at the API boundary. */
      deck?: HushleCard[];
    }
  | {
      type: 'set-teams';
      teams: Array<{ name: string; playerIds: string[] }>;
      /**
       * M20a — single extra player for odd-player games. The floater
       * explains for whichever team's turn it is on alternating
       * turns. Pass null (the default) for even-player games.
       */
      floaterPlayerId?: string | null;
    }
  | { type: 'start-turn'; teamId: string; explainerId: string | null }
  | { type: 'set-explainer'; explainerId: string | null }
  | { type: 'next-card' }
  | { type: 'correct-guess' }
  | { type: 'pass' }
  | { type: 'penalty' }
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
 * The current Hushle state schema version. Bump this and add a step
 * to `migrateHushleState` below whenever the state shape changes in
 * a backwards-incompatible way.
 *
 * M20a — bumped to 2. v2 adds `floaterPlayerId`, `currentExplainerIndex`,
 * `usedCardIds`, `settings.teamSize`, `settings.difficultyDistribution`,
 * and `difficulty` on each card.
 */
export const HUSHLE_STATE_VERSION = 2;

export function createHushleInitialState(): HushleState {
  return {
    version: HUSHLE_STATE_VERSION,
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
}

/**
 * Default values used when migrating a pre-versioned row to v2. Each
 * migration step returns a partial that gets merged onto the
 * previous shape, so adding v3 doesn't have to repeat v2's defaults.
 */
const HUSHLE_V2_DEFAULTS: Partial<HushleState> = {
  version: HUSHLE_STATE_VERSION,
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

const HUSHLE_V1_DEFAULTS: Partial<HushleState> = {
  ...HUSHLE_V2_DEFAULTS,
  // v1 had no floater / difficulty fields — they fall through to v2's defaults.
};

function migrateV0ToV1(raw: unknown): HushleState {
  // Pre-versioned state had no `version` field. Promote it to v1 with
  // defaults for any fields added in v1. The reducer's view of the
  // data is unchanged — `phase` / `teams` / `deck` already existed.
  const base = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  return {
    ...HUSHLE_V1_DEFAULTS,
    ...base,
    version: HUSHLE_STATE_VERSION,
    // settings was already in v0 but the schema may have drifted; merge
    // defaults so a partially-shaped row still loads.
    settings: {
      ...HUSHLE_V1_DEFAULTS.settings,
      ...(typeof base.settings === 'object' && base.settings !== null
        ? (base.settings as Record<string, unknown>)
        : {}),
    } as HushleSettings,
    timer: {
      ...HUSHLE_V1_DEFAULTS.timer,
      ...(typeof base.timer === 'object' && base.timer !== null
        ? (base.timer as Record<string, unknown>)
        : {}),
    } as HushleTimer,
  } as HushleState;
}

function migrateV1ToV2(raw: unknown): HushleState {
  // v1 had no `difficulty` on cards, no floater support, no
  // `teamSize` / `difficultyDistribution` on settings, no `usedCardIds`.
  // Promote every card to `easy` (the safest default; the per-session
  // `difficultyDistribution` will re-weight on first action if the
  // server owner configured non-default tiers). The reducer treats
  // unknown tiers as a no-op tier (drops out of the weighted draw).
  const base = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const oldDeck = Array.isArray(base.deck) ? (base.deck as Array<Record<string, unknown>>) : [];
  const deck: HushleCard[] = oldDeck.map((c) => ({
    id: typeof c.id === 'string' ? c.id : 'card-migrated',
    language: c.language === 'tr' ? 'tr' : 'en',
    word: typeof c.word === 'string' ? c.word : '',
    forbiddenWords: Array.isArray(c.forbiddenWords)
      ? (c.forbiddenWords as unknown[]).filter((w): w is string => typeof w === 'string')
      : [],
    difficulty: 'easy',
  }));
  const oldCurrentCard = base.currentCard as Record<string, unknown> | null | undefined;
  const currentCard: HushleCard | null =
    oldCurrentCard && typeof oldCurrentCard === 'object'
      ? {
          id: typeof oldCurrentCard.id === 'string' ? oldCurrentCard.id : 'card-migrated',
          language: oldCurrentCard.language === 'tr' ? 'tr' : 'en',
          word: typeof oldCurrentCard.word === 'string' ? oldCurrentCard.word : '',
          forbiddenWords: Array.isArray(oldCurrentCard.forbiddenWords)
            ? (oldCurrentCard.forbiddenWords as unknown[]).filter((w): w is string =>
                typeof w === 'string'
              )
            : [],
          difficulty: 'easy',
        }
      : null;
  return {
    ...HUSHLE_V2_DEFAULTS,
    ...base,
    version: HUSHLE_STATE_VERSION,
    floaterPlayerId: null,
    currentExplainerIndex: 0,
    usedCardIds: [],
    deck,
    currentCard,
    settings: {
      ...HUSHLE_V2_DEFAULTS.settings,
      ...(typeof base.settings === 'object' && base.settings !== null
        ? (base.settings as Record<string, unknown>)
        : {}),
      teamSize: HUSHLE_DEFAULT_TEAM_SIZE,
      difficultyDistribution: { ...HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION },
    } as HushleSettings,
    timer: {
      ...HUSHLE_V2_DEFAULTS.timer,
      ...(typeof base.timer === 'object' && base.timer !== null
        ? (base.timer as Record<string, unknown>)
        : {}),
    } as HushleTimer,
  } as HushleState;
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
  // if (version < 3) state = migrateV2ToV3(state);   ← add when v3 lands
  // ... chain forward ...
  return state as HushleState;
}
