/**
 * Quiz state model.
 *
 * The reducer (`./actions`) is server-authoritative: the host runs it for
 * every action and persists what it returns; the panel only renders the
 * PROJECTED state (see `QuizViewState`) and dispatches actions.
 *
 * Phases:
 *   lobby   — players join; the host sets the quiz up and starts it.
 *   playing — a question is open until its `deadline` (or until every
 *             eligible player has answered, or the host reveals early).
 *   reveal  — the correct answer, how many picked each option (counts
 *             only) and the leaderboard with this round's gains.
 *   ended   — podium and full ranking. Terminal: the host's action route
 *             refuses every action once a quiz has ended.
 *
 * Secret vs public fields — the core projection
 * (`packages/core/src/activity-projection.ts`, the `quiz` block) relies on
 * this split, so keep it when adding fields:
 *   SECRET  `deck`    every question of the game WITH its correct answer.
 *   SECRET  `answers` who picked what on the open question.
 *   public  everything else. `current` is the open question WITHOUT its
 *           answer; `reveal` is only filled once a question is revealed;
 *           players' scores only move at a reveal, so they can never be
 *           used to probe which option is right.
 *
 * Versioning: every persisted state carries `version`. Bump
 * `QUIZ_STATE_VERSION` and add a step to `migrateQuizState` when the
 * shape changes. v0/v1 (no `version` field) are the pre-2026 shapes: a
 * `questions` list pasted by the host, `currentAnswers`, `playerScores`.
 */

import { hasOwn, isFiniteNumber, isNonEmptyString, isRecord } from './guards';

export type QuizPhase = 'lobby' | 'playing' | 'reveal' | 'ended';
export type QuizSource = 'pack' | 'custom';
/** How a player did on the last revealed question. */
export type QuizRoundResult = 'correct' | 'wrong' | 'missed';
export type QuizEndReason = 'completed' | 'host';

export const QUIZ_STATE_VERSION = 2;

/** The host picks one of these in the setup screen. */
export const QUIZ_QUESTION_COUNTS = [5, 10, 15, 20] as const;
export const QUIZ_SECONDS_OPTIONS = [10, 20, 30] as const;
export const QUIZ_DEFAULT_QUESTION_COUNT = 10;
export const QUIZ_DEFAULT_SECONDS = 20;

/** Custom question lists (pasted by the host). */
export const QUIZ_MAX_QUESTIONS = 50;
export const QUIZ_MIN_OPTIONS = 2;
export const QUIZ_MAX_OPTIONS = 6;
export const QUIZ_MAX_TEXT = 300;

/** Longest player name kept in the state (the host's display name, stored at join). */
export const QUIZ_MAX_NAME = 64;
/** Active players at once (the catalogue's `maxPlayers`). */
export const QUIZ_MAX_PLAYERS = 32;
/** Everyone who ever joined this game, including those who left. */
export const QUIZ_MAX_ROSTER = 64;

/**
 * An answer sent before the deadline can arrive a little after it (the
 * round trip). Such answers still count — for base points only. After
 * `deadline + grace` answers are refused and anyone may call time.
 */
export const QUIZ_ANSWER_GRACE_MS = 1_000;

/** Scoring — see `quizPointsFor` in ./actions and docs/QUIZ.md. */
export const QUIZ_BASE_POINTS = 500;
export const QUIZ_SPEED_POINTS = 500;
export const QUIZ_STREAK_STEP = 100;
export const QUIZ_STREAK_MAX_BONUS = 300;

/** A question as a host pastes it (and as the legacy `set-questions` took it). */
export interface QuizQuestion {
  /** Optional: the reducer numbers questions itself. */
  id?: string;
  question: string;
  options: string[];
  correctIndex: number;
  /** Legacy per-question timer. Accepted, ignored — the game has one timer. */
  timeLimitSeconds?: number;
}

/** A question of the running game. SERVER ONLY (lives in `deck`). */
export interface QuizDeckQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
}

/** The open question as every viewer sees it — never with its answer. */
export interface QuizPublicQuestion {
  /** 0-based position in the game. */
  index: number;
  question: string;
  options: string[];
}

export interface QuizSettings {
  source: QuizSource;
  /** Built-in pack id (`general`, `science`, `geography`) when `source` is `pack`. */
  packId: string | null;
  /** The pack's language (`en`, `tr`). */
  packLanguage: string | null;
  /** What the host asked for; `questionTotal` is what the game really has. */
  questionCount: number;
  secondsPerQuestion: number;
  /** Random question order AND answer order. */
  shuffle: boolean;
}

export interface QuizPlayer {
  /** The user id (injected by the host as `playerId` — never trusted from the wire). */
  id: string;
  /**
   * The host's name for this player when they joined (`ctx.players`, never
   * the client). The panel prefers the live session name and falls back to
   * this, then to "Player N".
   */
  name: string | null;
  /** First question (0-based) this player may answer — late joiners start with the next one. */
  eligibleFrom: number;
  /** False once the player left; their points stay on the board. */
  active: boolean;
  score: number;
  /** Correct answers. */
  correct: number;
  /** Questions answered (right or wrong). */
  answered: number;
  /** Consecutive correct answers, including the last revealed one. */
  streak: number;
  bestStreak: number;
  /** Points won on the last revealed question (0 when wrong or silent). */
  lastGain: number;
  /** How the last revealed question went; null when this player sat it out. */
  lastResult: QuizRoundResult | null;
}

/** One locked answer to the open question. SERVER ONLY (lives in `answers`). */
export interface QuizAnswer {
  /** Option index. */
  choice: number;
  /** Server time (epoch ms) the answer arrived — drives the speed bonus. */
  at: number;
}

/** Published when a question is revealed: counts only, never who. */
export interface QuizReveal {
  index: number;
  correctIndex: number;
  /** How many players picked each option. */
  counts: number[];
  answered: number;
  correct: number;
}

export interface QuizState {
  version: number;
  phase: QuizPhase;
  settings: QuizSettings;
  /** Join order. */
  players: QuizPlayer[];
  /** SECRET — every question of this game, with answers, in play order. */
  deck: QuizDeckQuestion[];
  /** Number of questions in this game (public copy of `deck.length`). */
  questionTotal: number;
  /** Questions revealed (and so scored) so far — fewer than `questionTotal` if the host ended early. */
  questionsRevealed: number;
  currentIndex: number;
  current: QuizPublicQuestion | null;
  /** Server time (epoch ms) the open question was shown. */
  questionStartedAt: number | null;
  /** Server time (epoch ms) answers close. A deadline, never "seconds left". */
  deadline: number | null;
  /** SECRET — answers to the open (or just revealed) question, by player id. */
  answers: Record<string, QuizAnswer>;
  reveal: QuizReveal | null;
  startedAt: number | null;
  endedAt: number | null;
  endReason: QuizEndReason | null;
}

/**
 * What a viewer receives after the core projection: the secrets are gone,
 * replaced by counts and the viewer's own choice.
 */
export type QuizViewState = Omit<QuizState, 'deck' | 'answers'> & {
  /** Answers received for the open question. */
  answeredCount: number;
  /** The viewer's own locked option, or null. */
  myAnswer: number | null;
};

export type QuizStartAction = {
  type: 'start';
  source: QuizSource;
  /** `source: 'pack'` */
  packId?: string;
  language?: string;
  /**
   * `source: 'custom'`: the host's pasted questions. `source: 'pack'`: the
   * pack's questions, injected by the HOST on the server (never sent by the
   * client — any client value is replaced).
   */
  questions?: QuizQuestion[];
  questionCount?: number;
  secondsPerQuestion?: number;
  shuffle?: boolean;
};

/** Actions as the reducer sees them — `playerId` is injected by the host. */
export type QuizAction =
  | QuizStartAction
  /** Legacy paste flow: start a custom quiz with these questions, in order. */
  | { type: 'set-questions'; questions: QuizQuestion[] }
  | { type: 'join'; playerId: string }
  | { type: 'leave'; playerId: string }
  | { type: 'answer'; playerId: string; index: number }
  /** Anyone may call time once the deadline has passed — the reducer checks the clock. */
  | { type: 'time-up' }
  | { type: 'reveal' }
  | { type: 'next' }
  | { type: 'end' };

/** Actions as the CLIENT sends them — the host injects `playerId`. */
export type QuizClientAction =
  | QuizStartAction
  | { type: 'set-questions'; questions: QuizQuestion[] }
  | { type: 'join' }
  | { type: 'leave' }
  | { type: 'answer'; index: number }
  | { type: 'time-up' }
  | { type: 'reveal' }
  | { type: 'next' }
  | { type: 'end' };

export function defaultQuizSettings(): QuizSettings {
  return {
    source: 'pack',
    packId: null,
    packLanguage: null,
    questionCount: QUIZ_DEFAULT_QUESTION_COUNT,
    secondsPerQuestion: QUIZ_DEFAULT_SECONDS,
    shuffle: true,
  };
}

export function newQuizPlayer(id: string, name: string | null, eligibleFrom: number): QuizPlayer {
  return {
    id,
    name,
    eligibleFrom,
    active: true,
    score: 0,
    correct: 0,
    answered: 0,
    streak: 0,
    bestStreak: 0,
    lastGain: 0,
    lastResult: null,
  };
}

/**
 * A fresh lobby. The session's creator (the host) joins as a player — the
 * common case is a host who plays along; they can leave to only host.
 */
export function createQuizInitialState(creatorId?: string | null): QuizState {
  return {
    version: QUIZ_STATE_VERSION,
    phase: 'lobby',
    settings: defaultQuizSettings(),
    players: isNonEmptyString(creatorId) ? [newQuizPlayer(creatorId, null, 0)] : [],
    deck: [],
    questionTotal: 0,
    questionsRevealed: 0,
    currentIndex: 0,
    current: null,
    questionStartedAt: null,
    deadline: null,
    answers: {},
    reveal: null,
    startedAt: null,
    endedAt: null,
    endReason: null,
  };
}

export function publicQuestion(question: QuizDeckQuestion, index: number): QuizPublicQuestion {
  return { index, question: question.question, options: [...question.options] };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

const PHASES: readonly QuizPhase[] = ['lobby', 'playing', 'reveal', 'ended'];

function isPhase(value: unknown): value is QuizPhase {
  return typeof value === 'string' && (PHASES as readonly string[]).includes(value);
}

/** Nearest allowed timer to a legacy per-question limit. */
function nearestSeconds(value: unknown): number {
  if (!isFiniteNumber(value) || value <= 0) return QUIZ_DEFAULT_SECONDS;
  let best: number = QUIZ_SECONDS_OPTIONS[0];
  for (const option of QUIZ_SECONDS_OPTIONS) {
    if (Math.abs(option - value) < Math.abs(best - value)) best = option;
  }
  return best;
}

function legacyDeck(raw: unknown): QuizDeckQuestion[] {
  if (!Array.isArray(raw)) return [];
  const deck: QuizDeckQuestion[] = [];
  raw.forEach((item, i) => {
    if (!isRecord(item)) return;
    const text = typeof item.question === 'string' ? item.question : typeof item.prompt === 'string' ? item.prompt : '';
    const options = Array.isArray(item.options) ? item.options.filter((o): o is string => typeof o === 'string') : [];
    if (options.length === 0) return;
    const correct = isFiniteNumber(item.correctIndex) ? Math.trunc(item.correctIndex) : 0;
    deck.push({
      id: isNonEmptyString(item.id) ? item.id.slice(0, 64) : `q${i + 1}`,
      question: text,
      options,
      correctIndex: correct >= 0 && correct < options.length ? correct : 0,
    });
  });
  return deck;
}

/** v0/v1 → v2. The old shape scored 1 point per correct answer; it becomes base points. */
function migrateLegacy(s: Record<string, unknown>): QuizState {
  const deck = legacyDeck(s.questions);
  const finished = s.finished === true;
  let phase: QuizPhase = isPhase(s.phase) ? s.phase : finished ? 'ended' : deck.length > 0 ? 'playing' : 'lobby';
  if (finished) phase = 'ended';
  if (deck.length === 0) phase = phase === 'ended' ? 'ended' : 'lobby';

  const rawIndex = isFiniteNumber(s.currentIndex) ? Math.max(0, Math.trunc(s.currentIndex)) : 0;
  if ((phase === 'playing' || phase === 'reveal') && rawIndex >= deck.length) phase = 'ended';
  const currentIndex = Math.min(rawIndex, Math.max(0, deck.length - 1));

  const legacyAnswers = isRecord(s.currentAnswers) ? s.currentAnswers : {};
  const legacyScores = isRecord(s.playerScores) ? s.playerScores : {};
  const answers: Record<string, QuizAnswer> = {};
  for (const [playerId, choice] of Object.entries(legacyAnswers)) {
    if (isFiniteNumber(choice) && Number.isInteger(choice) && choice >= 0) answers[playerId] = { choice, at: 0 };
  }
  const ids = [...new Set([...Object.keys(legacyScores), ...Object.keys(answers)])];
  const players = ids.slice(0, QUIZ_MAX_ROSTER).map((id) => {
    const correct = isFiniteNumber(legacyScores[id]) ? Math.max(0, Math.trunc(legacyScores[id] as number)) : 0;
    return { ...newQuizPlayer(id, null, 0), score: correct * QUIZ_BASE_POINTS, correct, answered: correct };
  });

  const question = deck[currentIndex];
  const open = (phase === 'playing' || phase === 'reveal') && question !== undefined;
  let reveal: QuizReveal | null = null;
  if (phase === 'reveal' && question) {
    const counts = question.options.map(() => 0);
    let correct = 0;
    for (const answer of Object.values(answers)) {
      if (answer.choice < counts.length) counts[answer.choice] = (counts[answer.choice] ?? 0) + 1;
      if (answer.choice === question.correctIndex) correct += 1;
    }
    reveal = {
      index: currentIndex,
      correctIndex: question.correctIndex,
      counts,
      answered: Object.keys(answers).length,
      correct,
    };
  }
  const firstLimit = Array.isArray(s.questions) && isRecord(s.questions[0]) ? s.questions[0].timeLimitSeconds : undefined;
  // The old reducer scored a question when it was revealed or skipped.
  const questionsRevealed =
    phase === 'ended' ? Math.min(rawIndex, deck.length) : phase === 'reveal' ? currentIndex + 1 : phase === 'playing' ? currentIndex : 0;

  return {
    version: QUIZ_STATE_VERSION,
    phase,
    settings: {
      source: 'custom',
      packId: null,
      packLanguage: null,
      questionCount: deck.length > 0 ? deck.length : QUIZ_DEFAULT_QUESTION_COUNT,
      secondsPerQuestion: nearestSeconds(firstLimit),
      shuffle: false,
    },
    players,
    deck,
    questionTotal: deck.length,
    questionsRevealed,
    currentIndex: phase === 'ended' ? Math.min(rawIndex, deck.length) : currentIndex,
    current: open ? publicQuestion(question, currentIndex) : null,
    // The old shape had no timer: the host reveals by hand.
    questionStartedAt: null,
    deadline: null,
    answers: open ? answers : {},
    reveal,
    startedAt: null,
    endedAt: null,
    endReason: phase === 'ended' ? 'completed' : null,
  };
}

/** Fill anything a v2 blob is missing; returns the input itself when nothing is. */
function normalizeV2(s: Record<string, unknown>): QuizState {
  const complete =
    isPhase(s.phase) &&
    isRecord(s.settings) &&
    Array.isArray(s.players) &&
    Array.isArray(s.deck) &&
    isFiniteNumber(s.questionTotal) &&
    isFiniteNumber(s.questionsRevealed) &&
    isFiniteNumber(s.currentIndex) &&
    isRecord(s.answers) &&
    hasOwn(s, 'current') &&
    hasOwn(s, 'reveal') &&
    hasOwn(s, 'deadline');
  if (complete) return s as unknown as QuizState;
  const base = createQuizInitialState();
  const deck = Array.isArray(s.deck) ? (s.deck as QuizDeckQuestion[]) : base.deck;
  return {
    ...base,
    ...(s as Partial<QuizState>),
    version: QUIZ_STATE_VERSION,
    phase: isPhase(s.phase) ? s.phase : base.phase,
    settings: { ...base.settings, ...(isRecord(s.settings) ? (s.settings as Partial<QuizSettings>) : {}) },
    players: Array.isArray(s.players) ? (s.players as QuizPlayer[]) : base.players,
    deck,
    questionTotal: isFiniteNumber(s.questionTotal) ? s.questionTotal : deck.length,
    questionsRevealed: isFiniteNumber(s.questionsRevealed) ? s.questionsRevealed : 0,
    currentIndex: isFiniteNumber(s.currentIndex) ? s.currentIndex : 0,
    answers: isRecord(s.answers) ? (s.answers as Record<string, QuizAnswer>) : {},
    current: isRecord(s.current) ? (s.current as unknown as QuizPublicQuestion) : null,
    reveal: isRecord(s.reveal) ? (s.reveal as unknown as QuizReveal) : null,
    deadline: isFiniteNumber(s.deadline) ? s.deadline : null,
  };
}

/**
 * Upgrade whatever is persisted to the current shape. The host runs this
 * on every read and before every action, so it must be idempotent — and
 * cheap: a current-version state comes back as the same object.
 */
export function migrateQuizState(raw: unknown): QuizState {
  if (!isRecord(raw)) return createQuizInitialState();
  const version = isFiniteNumber(raw.version) ? raw.version : 0;
  if (version >= QUIZ_STATE_VERSION) return normalizeV2(raw);
  return migrateLegacy(raw);
}
