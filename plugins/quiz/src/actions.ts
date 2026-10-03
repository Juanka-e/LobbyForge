/**
 * Quiz rules: the action validator and the reducer.
 *
 * Who may send what is declared in `actionPolicies` (./index): the host
 * starts, reveals, advances and ends; any member joins, leaves, answers
 * and calls time. The host injects `playerId` from the session (never from
 * the wire), so a player can only ever act as themselves.
 *
 * Timing: a question has a DEADLINE (server epoch ms). Answers lock at the
 * deadline — plus `QUIZ_ANSWER_GRACE_MS` for answers already in flight —
 * or as soon as every eligible player has answered, whichever is first.
 * The HTTP host has no server timers, so "time's up" is an action anyone
 * may send (`time-up`); the reducer accepts it only once the server clock
 * is past the deadline, so sending it early changes nothing.
 *
 * Randomness and time come from `env` — the platform CSPRNG and `Date.now`
 * on the server; tests pass stubs. No action field can seed or steer them.
 *
 * Built-in packs: this module only knows the pack CATALOGUE. A pack game's
 * questions (with answers) are loaded on the server by the host — from the
 * `@lobbyforge/quiz/packs` subpath, in its prepare step — and injected into
 * the `start` action, replacing anything the client sent. So the answers
 * never ship in the plugin's client bundle.
 */

import { buildDeck } from './deck';
import { hasOwn, isFiniteNumber, isNonEmptyString, isRecord } from './guards';
import { findQuizPackSummary } from './packs';
import { eligiblePlayers } from './roster';
import {
  QUIZ_ANSWER_GRACE_MS,
  QUIZ_BASE_POINTS,
  QUIZ_DEFAULT_QUESTION_COUNT,
  QUIZ_DEFAULT_SECONDS,
  QUIZ_MAX_NAME,
  QUIZ_MAX_OPTIONS,
  QUIZ_MAX_PLAYERS,
  QUIZ_MAX_QUESTIONS,
  QUIZ_MAX_ROSTER,
  QUIZ_MAX_TEXT,
  QUIZ_MIN_OPTIONS,
  QUIZ_QUESTION_COUNTS,
  QUIZ_SECONDS_OPTIONS,
  QUIZ_SPEED_POINTS,
  QUIZ_STREAK_MAX_BONUS,
  QUIZ_STREAK_STEP,
  newQuizPlayer,
  publicQuestion,
  type QuizAction,
  type QuizDeckQuestion,
  type QuizEndReason,
  type QuizPlayer,
  type QuizQuestion,
  type QuizSettings,
  type QuizStartAction,
  type QuizState,
} from './state';
import { secureRandom } from './random';

export interface QuizEnv {
  /** Server time, epoch ms. */
  now: () => number;
  /** Uniform in [0, 1). */
  random: () => number;
  /** The host's name for a user (`ctx.players`), or null when it has none. */
  nameOf?: (userId: string) => string | null;
}

export const QUIZ_DEFAULT_ENV: QuizEnv = {
  now: () => Date.now(),
  random: secureRandom,
};

// ---------------------------------------------------------------------------
// Validation (the host calls this before dispatch; the reducer re-checks)
// ---------------------------------------------------------------------------

const normalizeOption = (option: string) => option.trim().toLowerCase();

function validateQuestion(q: unknown, i: number): string | null {
  if (!isRecord(q)) return `questions[${i}] must be an object.`;
  if (q.id !== undefined && (typeof q.id !== 'string' || q.id.length === 0 || q.id.length > 64)) {
    return `questions[${i}].id must be a 1–64 character string.`;
  }
  if (typeof q.question !== 'string' || q.question.trim().length === 0 || q.question.length > QUIZ_MAX_TEXT) {
    return `questions[${i}].question must be 1–${QUIZ_MAX_TEXT} characters.`;
  }
  if (
    !Array.isArray(q.options) ||
    q.options.length < QUIZ_MIN_OPTIONS ||
    q.options.length > QUIZ_MAX_OPTIONS ||
    q.options.some((o) => typeof o !== 'string' || o.trim().length === 0 || o.length > QUIZ_MAX_TEXT)
  ) {
    return `questions[${i}].options must be ${QUIZ_MIN_OPTIONS}–${QUIZ_MAX_OPTIONS} non-empty strings.`;
  }
  const options = q.options as string[];
  if (new Set(options.map(normalizeOption)).size !== options.length) {
    return `questions[${i}].options must all be different.`;
  }
  if (
    typeof q.correctIndex !== 'number' ||
    !Number.isInteger(q.correctIndex) ||
    q.correctIndex < 0 ||
    q.correctIndex >= options.length
  ) {
    return `questions[${i}].correctIndex must index one of the options.`;
  }
  if (
    q.timeLimitSeconds !== undefined &&
    (typeof q.timeLimitSeconds !== 'number' ||
      !Number.isFinite(q.timeLimitSeconds) ||
      q.timeLimitSeconds <= 0 ||
      q.timeLimitSeconds > 600)
  ) {
    return `questions[${i}].timeLimitSeconds must be between 1 and 600.`;
  }
  return null;
}

function validateQuestionList(questions: unknown): string | null {
  if (!Array.isArray(questions)) return 'questions must be an array.';
  if (questions.length === 0) return 'questions must contain at least one question.';
  if (questions.length > QUIZ_MAX_QUESTIONS) return `at most ${QUIZ_MAX_QUESTIONS} questions are allowed.`;
  for (let i = 0; i < questions.length; i += 1) {
    const error = validateQuestion(questions[i], i);
    if (error) return error;
  }
  return null;
}

function isOneOf(value: unknown, allowed: readonly number[]): boolean {
  return typeof value === 'number' && allowed.includes(value);
}

function validateStart(action: Record<string, unknown>): string | null {
  if (action.source === 'pack') {
    if (!isNonEmptyString(action.packId) || !isNonEmptyString(action.language)) {
      return 'start with a pack requires packId and language strings.';
    }
    if (!findQuizPackSummary(action.packId, action.language)) return 'Unknown question pack.';
    // The client never sends a pack's questions — the host injects them after
    // this check. Anything present must still be a well-formed list.
    if (action.questions !== undefined) {
      const error = validateQuestionList(action.questions);
      if (error) return error;
    }
  } else if (action.source === 'custom') {
    const error = validateQuestionList(action.questions);
    if (error) return error;
  } else {
    return 'start requires source "pack" or "custom".';
  }
  if (action.questionCount !== undefined && !isOneOf(action.questionCount, QUIZ_QUESTION_COUNTS)) {
    return `questionCount must be one of ${QUIZ_QUESTION_COUNTS.join(', ')}.`;
  }
  if (action.secondsPerQuestion !== undefined && !isOneOf(action.secondsPerQuestion, QUIZ_SECONDS_OPTIONS)) {
    return `secondsPerQuestion must be one of ${QUIZ_SECONDS_OPTIONS.join(', ')}.`;
  }
  if (action.shuffle !== undefined && typeof action.shuffle !== 'boolean') return 'shuffle must be a boolean.';
  return null;
}

/** Runtime guard for raw HTTP payloads (31st-audit contract). */
export function quizValidateAction(action: unknown): string | null {
  if (!isRecord(action)) return 'Action must be an object.';
  switch (action.type) {
    case 'start':
      return validateStart(action);
    case 'set-questions':
      return validateQuestionList(action.questions);
    case 'join':
      // No name on the wire: the reducer takes it from the host (`env.nameOf`).
      return isNonEmptyString(action.playerId) ? null : 'join requires a playerId string.';
    case 'leave':
      return isNonEmptyString(action.playerId) ? null : 'leave requires a playerId string.';
    case 'answer':
      if (typeof action.index !== 'number' || !Number.isInteger(action.index) || action.index < 0) {
        return 'answer requires a non-negative integer index.';
      }
      if (!isNonEmptyString(action.playerId)) return 'answer requires a playerId string.';
      return null;
    case 'time-up':
    case 'reveal':
    case 'next':
    case 'end':
      return null;
    default:
      return `Unknown action type: ${String(action.type)}`;
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Points for a CORRECT answer (wrong or missing answers score 0):
 *
 *   base   500
 *   speed  up to 500 — 500 × (time left when the answer arrived ÷ time allowed),
 *          rounded; 0 for answers in the grace window after the deadline
 *   streak +100 for each correct answer in a row before this one, at most +300
 *
 * So 500–1,300 points per question. `streak` counts this answer too.
 */
export function quizPointsFor(
  answeredAt: number,
  questionStartedAt: number | null,
  deadline: number | null,
  streak: number
): number {
  let speed = 0;
  if (questionStartedAt !== null && deadline !== null && deadline > questionStartedAt) {
    const left = Math.min(1, Math.max(0, (deadline - answeredAt) / (deadline - questionStartedAt)));
    speed = Math.round(QUIZ_SPEED_POINTS * left);
  }
  const streakBonus = Math.min(QUIZ_STREAK_MAX_BONUS, Math.max(0, streak - 1) * QUIZ_STREAK_STEP);
  return QUIZ_BASE_POINTS + speed + streakBonus;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]', 'g');

/** Trimmed, single-spaced, printable, at most QUIZ_MAX_NAME characters; null when empty. */
export function cleanQuizName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Control characters, zero-width and bidi overrides: a name must not be
  // able to hide itself or flip the text around it.
  const flat = raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const clipped = Array.from(flat).slice(0, QUIZ_MAX_NAME).join('').trim();
  return clipped.length > 0 ? clipped : null;
}

/** Pasted questions are numbered by the reducer (`c1`…); a pack's keep their stable ids. */
function questionPool(questions: readonly QuizQuestion[], keepIds: boolean): QuizDeckQuestion[] {
  return questions.map((question, index) => ({
    id: keepIds && isNonEmptyString(question.id) ? question.id : `c${index + 1}`,
    question: question.question.trim(),
    options: question.options.map((option) => option.trim()),
    correctIndex: question.correctIndex,
  }));
}

function openQuestion(state: QuizState, index: number, now: number): QuizState {
  const question = state.deck[index];
  if (!question) return finish(state, 'completed', now);
  return {
    ...state,
    phase: 'playing',
    currentIndex: index,
    current: publicQuestion(question, index),
    questionStartedAt: now,
    deadline: now + state.settings.secondsPerQuestion * 1000,
    answers: {},
    reveal: null,
  };
}

function finish(state: QuizState, reason: QuizEndReason, now: number): QuizState {
  // An unrevealed question is void: its answers are dropped, nobody scores it.
  return {
    ...state,
    phase: 'ended',
    current: null,
    questionStartedAt: null,
    deadline: null,
    answers: {},
    reveal: null,
    endedAt: now,
    endReason: reason,
  };
}

function startQuiz(state: QuizState, action: QuizStartAction, env: QuizEnv, legacy: boolean): QuizState {
  if (state.phase !== 'lobby') return state;
  const players = state.players.filter((player) => player.active);
  // Somebody has to play: spectators alone cannot answer anything.
  if (players.length === 0) return state;

  let pool: QuizDeckQuestion[];
  let source: Pick<QuizSettings, 'source' | 'packId' | 'packLanguage'>;
  if (!Array.isArray(action.questions) || action.questions.length === 0) {
    // A pack game's questions are injected by the host on the server; a
    // `start` that arrives without them (no host hydration) has nothing to play.
    return state;
  }
  if (action.source === 'pack') {
    const pack = findQuizPackSummary(action.packId, action.language);
    if (!pack) return state;
    pool = questionPool(action.questions, true);
    source = { source: 'pack', packId: pack.id, packLanguage: pack.language };
  } else {
    pool = questionPool(action.questions, false);
    source = { source: 'custom', packId: null, packLanguage: null };
  }

  const settings: QuizSettings = {
    ...source,
    // The legacy paste flow asks every pasted question, in order.
    questionCount: legacy
      ? pool.length
      : isFiniteNumber(action.questionCount) && (QUIZ_QUESTION_COUNTS as readonly number[]).includes(action.questionCount)
        ? action.questionCount
        : QUIZ_DEFAULT_QUESTION_COUNT,
    secondsPerQuestion:
      isFiniteNumber(action.secondsPerQuestion) &&
      (QUIZ_SECONDS_OPTIONS as readonly number[]).includes(action.secondsPerQuestion)
        ? action.secondsPerQuestion
        : QUIZ_DEFAULT_SECONDS,
    shuffle: typeof action.shuffle === 'boolean' ? action.shuffle : !legacy,
  };
  const deck = buildDeck(pool, settings.questionCount, settings.shuffle, env.random);
  if (deck.length === 0) return state;

  const now = env.now();
  return openQuestion(
    {
      ...state,
      settings,
      // Fresh scores; everyone in the lobby plays from the first question.
      players: players.map((player) => newQuizPlayer(player.id, player.name, 0)),
      deck,
      questionTotal: deck.length,
      questionsRevealed: 0,
      startedAt: now,
      endedAt: null,
      endReason: null,
    },
    0,
    now
  );
}

function everyoneAnswered(state: QuizState): boolean {
  const eligible = eligiblePlayers(state.players, state.currentIndex);
  return eligible.length > 0 && eligible.every((player) => hasOwn(state.answers, player.id));
}

/** Lock the open question, score it and publish the counts. */
export function revealQuestion(state: QuizState): QuizState {
  if (state.phase !== 'playing') return state;
  const question = state.deck[state.currentIndex];
  if (!question) return state;

  const counts = question.options.map(() => 0);
  let answered = 0;
  let correct = 0;
  for (const answer of Object.values(state.answers)) {
    if (!Number.isInteger(answer.choice) || answer.choice < 0 || answer.choice >= counts.length) continue;
    counts[answer.choice] = (counts[answer.choice] ?? 0) + 1;
    answered += 1;
    if (answer.choice === question.correctIndex) correct += 1;
  }

  const players = state.players.map((player): QuizPlayer => {
    const answer = hasOwn(state.answers, player.id) ? state.answers[player.id] : undefined;
    if (answer) {
      if (answer.choice === question.correctIndex) {
        const streak = player.streak + 1;
        const gain = quizPointsFor(answer.at, state.questionStartedAt, state.deadline, streak);
        return {
          ...player,
          score: player.score + gain,
          correct: player.correct + 1,
          answered: player.answered + 1,
          streak,
          bestStreak: Math.max(player.bestStreak, streak),
          lastGain: gain,
          lastResult: 'correct',
        };
      }
      return { ...player, answered: player.answered + 1, streak: 0, lastGain: 0, lastResult: 'wrong' };
    }
    if (player.active && player.eligibleFrom <= state.currentIndex) {
      // Could have answered and did not: the streak breaks.
      return { ...player, streak: 0, lastGain: 0, lastResult: 'missed' };
    }
    // Sat this one out (joined later, or left): nothing changes but the last-round fields.
    return { ...player, lastGain: 0, lastResult: null };
  });

  return {
    ...state,
    phase: 'reveal',
    players,
    questionsRevealed: state.questionsRevealed + 1,
    reveal: { index: state.currentIndex, correctIndex: question.correctIndex, counts, answered, correct },
  };
}

function join(state: QuizState, action: Extract<QuizAction, { type: 'join' }>, env: QuizEnv): QuizState {
  if (state.phase === 'ended') return state;
  // The name comes from the host's roster, never from the client.
  const name = cleanQuizName(env.nameOf?.(action.playerId) ?? null);
  // Late joiners answer from the NEXT question — never the one already open.
  const eligibleFrom = state.phase === 'lobby' ? 0 : state.currentIndex + 1;
  const activeCount = state.players.filter((player) => player.active).length;
  const index = state.players.findIndex((player) => player.id === action.playerId);

  if (index >= 0) {
    const player = state.players[index]!;
    const nextName = name ?? player.name;
    if (player.active) {
      if (nextName === player.name) return state;
      return { ...state, players: state.players.map((p, i) => (i === index ? { ...p, name: nextName } : p)) };
    }
    if (activeCount >= QUIZ_MAX_PLAYERS) return state;
    const back: QuizPlayer = {
      ...player,
      name: nextName,
      active: true,
      eligibleFrom: Math.max(player.eligibleFrom, eligibleFrom),
    };
    return { ...state, players: state.players.map((p, i) => (i === index ? back : p)) };
  }

  if (activeCount >= QUIZ_MAX_PLAYERS || state.players.length >= QUIZ_MAX_ROSTER) return state;
  return { ...state, players: [...state.players, newQuizPlayer(action.playerId, name, eligibleFrom)] };
}

function leave(state: QuizState, action: Extract<QuizAction, { type: 'leave' }>): QuizState {
  if (state.phase === 'ended') return state;
  const index = state.players.findIndex((player) => player.id === action.playerId);
  if (index < 0) return state;
  // Before the start nothing is at stake: just drop them.
  if (state.phase === 'lobby') return { ...state, players: state.players.filter((_, i) => i !== index) };
  const player = state.players[index]!;
  if (!player.active) return state;
  // Mid-game they keep their points (and an answer already locked still counts).
  const next: QuizState = {
    ...state,
    players: state.players.map((p, i) => (i === index ? { ...p, active: false } : p)),
  };
  return next.phase === 'playing' && everyoneAnswered(next) ? revealQuestion(next) : next;
}

function answer(state: QuizState, action: Extract<QuizAction, { type: 'answer' }>, env: QuizEnv): QuizState {
  if (state.phase !== 'playing') return state;
  const question = state.deck[state.currentIndex];
  if (!question || action.index >= question.options.length) return state;
  const player = state.players.find((p) => p.id === action.playerId);
  // Spectators and players who join mid-question cannot answer it.
  if (!player || !player.active || player.eligibleFrom > state.currentIndex) return state;
  // One locked answer per player per question — no retries, no probing.
  if (hasOwn(state.answers, action.playerId)) return state;
  const now = env.now();
  if (state.deadline !== null && now > state.deadline + QUIZ_ANSWER_GRACE_MS) return state;
  const next: QuizState = {
    ...state,
    answers: { ...state.answers, [action.playerId]: { choice: action.index, at: now } },
  };
  return everyoneAnswered(next) ? revealQuestion(next) : next;
}

export function quizReducer(state: QuizState, action: QuizAction, env: QuizEnv = QUIZ_DEFAULT_ENV): QuizState {
  switch (action.type) {
    case 'start':
      return startQuiz(state, action, env, false);
    case 'set-questions':
      return startQuiz(state, { type: 'start', source: 'custom', questions: action.questions }, env, true);
    case 'join':
      return join(state, action, env);
    case 'leave':
      return leave(state, action);
    case 'answer':
      return answer(state, action, env);
    case 'time-up':
      if (state.phase !== 'playing' || state.deadline === null) return state;
      if (env.now() < state.deadline + QUIZ_ANSWER_GRACE_MS) return state;
      return revealQuestion(state);
    case 'reveal':
      return revealQuestion(state);
    case 'next': {
      if (state.phase !== 'reveal') return state;
      const now = env.now();
      const nextIndex = state.currentIndex + 1;
      return nextIndex >= state.deck.length ? finish(state, 'completed', now) : openQuestion(state, nextIndex, now);
    }
    case 'end': {
      if (state.phase !== 'playing' && state.phase !== 'reveal') return state;
      const allRevealed = state.phase === 'reveal' && state.currentIndex >= state.deck.length - 1;
      return finish(state, allRevealed ? 'completed' : 'host', env.now());
    }
    default:
      return state;
  }
}
