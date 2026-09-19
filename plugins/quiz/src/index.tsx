import type { GamePlugin } from '@lobbyforge/plugin-sdk';
import { PluginPermission } from '@lobbyforge/plugin-sdk';

/**
 * Quiz — experimental trivia rounds.
 *
 * beta-review (answer probing): `answer` used to score immediately with
 * no per-player record, so any member could try every option and watch
 * the shared score move to learn the correct answer. Now:
 *   - each player gets ONE locked answer per question (the host injects
 *     the actor as `playerId` — never trusted from the wire);
 *   - nothing is scored until the host REVEALS the question (or moves
 *     on), so the score cannot be used as a correctness oracle;
 *   - the canonical projector (@lobbyforge/core) strips `correctIndex`
 *     and other players' answers until the `reveal` phase.
 */

export interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  timeLimitSeconds: number;
}

export type QuizPhase = 'lobby' | 'playing' | 'reveal' | 'ended';

export interface QuizState {
  questions: QuizQuestion[];
  currentIndex: number;
  /** Aggregate correct answers across all players (scored at reveal). */
  score: number;
  correctCount: number;
  totalAnswered: number;
  finished: boolean;
  phase: QuizPhase;
  /** Answers to the CURRENT question: playerId → option index. */
  currentAnswers: Record<string, number>;
  /** Per-player correct answers — only updated when a question is revealed. */
  playerScores: Record<string, number>;
}

/** What a viewer receives after projection (see @lobbyforge/core). */
export type QuizViewState = QuizState & {
  /** Number of players who answered the current question (pre-reveal). */
  answeredCount?: number;
};

export type QuizAction =
  | { type: 'set-questions'; questions: QuizQuestion[] }
  | { type: 'answer'; index: number; playerId: string }
  | { type: 'reveal' }
  | { type: 'next' }
  | { type: 'end' };

/** Actions as the CLIENT sends them — the host injects `playerId`. */
export type QuizClientAction =
  | { type: 'set-questions'; questions: QuizQuestion[] }
  | { type: 'answer'; index: number }
  | { type: 'reveal' }
  | { type: 'next' }
  | { type: 'end' };

export interface QuizClientProps {
  state: QuizViewState;
  dispatch: (action: QuizClientAction) => void;
  actorUserId: string;
  hostUserId: string;
  players: Array<{ userId: string; name?: string | null }>;
}

export const QUIZ_MAX_QUESTIONS = 50;
export const QUIZ_MIN_OPTIONS = 2;
export const QUIZ_MAX_OPTIONS = 6;
const QUIZ_MAX_TEXT = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function validateQuestion(q: unknown, i: number): string | null {
  if (!isRecord(q)) return `questions[${i}] must be an object.`;
  if (typeof q.id !== 'string' || q.id.length === 0 || q.id.length > 64) {
    return `questions[${i}].id must be a 1–64 character string.`;
  }
  if (typeof q.question !== 'string' || q.question.trim().length === 0 || q.question.length > QUIZ_MAX_TEXT) {
    return `questions[${i}].question must be 1–${QUIZ_MAX_TEXT} characters.`;
  }
  if (
    !Array.isArray(q.options) ||
    q.options.length < QUIZ_MIN_OPTIONS ||
    q.options.length > QUIZ_MAX_OPTIONS ||
    q.options.some((o) => typeof o !== 'string' || o.length === 0 || o.length > QUIZ_MAX_TEXT)
  ) {
    return `questions[${i}].options must be ${QUIZ_MIN_OPTIONS}–${QUIZ_MAX_OPTIONS} non-empty strings.`;
  }
  if (
    typeof q.correctIndex !== 'number' ||
    !Number.isInteger(q.correctIndex) ||
    q.correctIndex < 0 ||
    q.correctIndex >= q.options.length
  ) {
    return `questions[${i}].correctIndex must index one of the options.`;
  }
  if (
    typeof q.timeLimitSeconds !== 'number' ||
    !Number.isFinite(q.timeLimitSeconds) ||
    q.timeLimitSeconds <= 0 ||
    q.timeLimitSeconds > 600
  ) {
    return `questions[${i}].timeLimitSeconds must be between 1 and 600.`;
  }
  return null;
}

/** Runtime guard for raw HTTP payloads (31st-audit contract). */
export function quizValidateAction(action: unknown): string | null {
  if (!isRecord(action)) return 'Action must be an object.';
  switch (action.type) {
    case 'set-questions': {
      if (!Array.isArray(action.questions)) return 'questions must be an array.';
      if (action.questions.length > QUIZ_MAX_QUESTIONS) {
        return `at most ${QUIZ_MAX_QUESTIONS} questions are allowed.`;
      }
      for (let i = 0; i < action.questions.length; i++) {
        const error = validateQuestion(action.questions[i], i);
        if (error) return error;
      }
      return null;
    }
    case 'answer':
      if (typeof action.index !== 'number' || !Number.isInteger(action.index) || action.index < 0) {
        return 'answer requires a non-negative integer index.';
      }
      if (typeof action.playerId !== 'string' || action.playerId.length === 0) {
        return 'answer requires a playerId string.';
      }
      return null;
    case 'reveal':
    case 'next':
    case 'end':
      return null;
    default:
      return `Unknown action type: ${String(action.type)}`;
  }
}

/**
 * Upgrade a persisted state (possibly written before the phase /
 * per-player fields existed). Idempotent.
 */
export function migrateQuizState(raw: unknown): QuizState {
  const s = isRecord(raw) ? raw : {};
  const questions = Array.isArray(s.questions) ? (s.questions as QuizQuestion[]) : [];
  const finished = s.finished === true;
  const phase: QuizPhase =
    s.phase === 'lobby' || s.phase === 'playing' || s.phase === 'reveal' || s.phase === 'ended'
      ? s.phase
      : finished
        ? 'ended'
        : questions.length > 0
          ? 'playing'
          : 'lobby';
  return {
    questions,
    currentIndex: typeof s.currentIndex === 'number' ? s.currentIndex : 0,
    score: typeof s.score === 'number' ? s.score : 0,
    correctCount: typeof s.correctCount === 'number' ? s.correctCount : 0,
    totalAnswered: typeof s.totalAnswered === 'number' ? s.totalAnswered : 0,
    finished,
    phase,
    currentAnswers: isRecord(s.currentAnswers) ? (s.currentAnswers as Record<string, number>) : {},
    playerScores: isRecord(s.playerScores) ? (s.playerScores as Record<string, number>) : {},
  };
}

/** Score the current question's locked answers and enter `reveal`. */
function revealCurrent(state: QuizState): QuizState {
  const q = state.questions[state.currentIndex];
  if (!q) return { ...state, phase: 'reveal' };
  const playerScores = { ...state.playerScores };
  let correct = 0;
  const entries = Object.entries(state.currentAnswers);
  for (const [playerId, index] of entries) {
    if (index === q.correctIndex) {
      correct += 1;
      playerScores[playerId] = (playerScores[playerId] ?? 0) + 1;
    }
  }
  return {
    ...state,
    phase: 'reveal',
    playerScores,
    score: state.score + correct,
    correctCount: state.correctCount + correct,
    totalAnswered: state.totalAnswered + entries.length,
  };
}

function initialQuizState(): QuizState {
  return {
    questions: [],
    currentIndex: 0,
    score: 0,
    correctCount: 0,
    totalAnswered: 0,
    finished: false,
    phase: 'lobby',
    currentAnswers: {},
    playerScores: {},
  };
}

export const quizPlugin: GamePlugin<QuizState, QuizAction> = {
  manifest: {
    id: 'quiz',
    name: 'Quiz',
    version: '0.2.0',
    type: 'game',
    minAppVersion: '0.1.0',
    permissions: [
      PluginPermission.MANAGE_GAME_SESSION,
      PluginPermission.MANAGE_SCORES,
      PluginPermission.SEND_ROOM_MESSAGE,
      PluginPermission.MANAGE_TIMER,
    ],
    locales: ['en', 'tr'],
    entryClient: './client.js',
    catalog: {
      category: 'game',
      summary: 'Fast trivia rounds for voice rooms.',
      publisher: 'LobbyForge',
      trustLevel: 'official',
      playerConfig: {
        minPlayers: 1,
        maxPlayers: 32,
        defaultMaxPlayers: 12,
        supportsSpectators: true,
        supportsQueue: false,
        overflowPolicy: 'spectator',
      },
      requiresVoiceRoom: true,
      externalAccountRequired: false,
      compatibleAppVersion: '>=0.1.0',
      tags: ['trivia', 'party', 'voice'],
    },
  },
  actionPolicies: {
    'set-questions': { role: 'host' },
    // beta-review: the actor is injected server-side — one answer each.
    answer: { role: 'member', actorFields: ['playerId'] },
    reveal: { role: 'host' },
    next: { role: 'host' },
    end: { role: 'host' },
  },
  createInitialState: () => initialQuizState(),
  validateAction: quizValidateAction,
  migrateState: migrateQuizState,
  handleAction: (_ctx, rawState, action) => {
    // Defense in depth: validateAction guards the API boundary, but the
    // reducer never trusts shape either.
    if (quizValidateAction(action) !== null) return rawState;
    const state = migrateQuizState(rawState);
    switch (action.type) {
      case 'set-questions':
        return {
          ...initialQuizState(),
          questions: action.questions,
          phase: action.questions.length > 0 ? 'playing' : 'lobby',
        };
      case 'answer': {
        if (state.phase !== 'playing') return state;
        const q = state.questions[state.currentIndex];
        if (!q) return state;
        if (action.index >= q.options.length) return state;
        // One locked answer per player per question — no retries, so the
        // (reveal-time) score cannot be probed option by option.
        if (hasOwn(state.currentAnswers, action.playerId)) return state;
        return {
          ...state,
          currentAnswers: { ...state.currentAnswers, [action.playerId]: action.index },
        };
      }
      case 'reveal':
        if (state.phase !== 'playing') return state;
        return revealCurrent(state);
      case 'next': {
        if (state.phase !== 'playing' && state.phase !== 'reveal') return state;
        // Skipping the reveal still scores the locked answers.
        const scored = state.phase === 'playing' ? revealCurrent(state) : state;
        const nextIndex = state.currentIndex + 1;
        const finished = nextIndex >= state.questions.length;
        return {
          ...scored,
          currentIndex: nextIndex,
          finished,
          phase: finished ? 'ended' : 'playing',
          currentAnswers: {},
        };
      }
      case 'end': {
        const scored = state.phase === 'playing' ? revealCurrent(state) : state;
        return { ...scored, finished: true, phase: 'ended' };
      }
      default:
        return state;
    }
  },
  renderClient: (props) => {
    const { state, dispatch, actorUserId, hostUserId } = props as QuizClientProps;
    const isHost = hostUserId === actorUserId;
    const myScore = state.playerScores?.[actorUserId] ?? 0;

    if (state.finished || state.phase === 'ended') {
      return (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <h2 style={{ fontSize: 24, fontWeight: 700, color: '#e0e2ea' }}>
            Quiz Complete!
          </h2>
          <p style={{ fontSize: 18, color: '#8fb8ff', marginTop: 12 }}>
            Your score: {myScore} · {state.correctCount}/{state.totalAnswered} correct overall
          </p>
        </div>
      );
    }

    const question = state.questions[state.currentIndex];
    if (!question) {
      return (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <p style={{ color: '#8b93a7' }}>
            {isHost ? 'Add questions to start the quiz.' : 'Waiting for the host to start...'}
          </p>
        </div>
      );
    }

    const revealed = state.phase === 'reveal';
    const answers = state.currentAnswers ?? {};
    const myAnswer = hasOwn(answers, actorUserId) ? answers[actorUserId] : undefined;
    const answeredCount = revealed ? Object.keys(answers).length : state.answeredCount ?? 0;

    return (
      <div style={{ padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 14, color: '#8b93a7' }}>
            Question {state.currentIndex + 1} / {state.questions.length} · {answeredCount} answered
          </span>
          <span style={{ fontSize: 14, color: '#8fb8ff', fontWeight: 600 }}>
            Score: {myScore}
          </span>
        </div>
        <h3 style={{ fontSize: 18, fontWeight: 600, color: '#e0e2ea', marginBottom: 16 }}>
          {question.question}
        </h3>
        <div style={{ display: 'grid', gap: 8 }}>
          {question.options.map((option, idx) => {
            const chosen = myAnswer === idx;
            const isCorrect = revealed && question.correctIndex === idx;
            const locked = revealed || myAnswer !== undefined;
            return (
              <button
                key={idx}
                disabled={locked}
                onClick={() => dispatch({ type: 'answer', index: idx })}
                style={{
                  padding: '12px 16px', borderRadius: 8, textAlign: 'left',
                  background: isCorrect ? '#1d3b2a' : chosen ? '#22324d' : '#171e2b',
                  color: '#e0e2ea',
                  border: `1px solid ${isCorrect ? '#5ad48a' : chosen ? '#8fb8ff' : '#1f2738'}`,
                  cursor: locked ? 'default' : 'pointer', fontSize: 14,
                  opacity: locked && !chosen && !isCorrect ? 0.7 : 1,
                }}
              >
                {option}
              </button>
            );
          })}
        </div>
        {myAnswer !== undefined && !revealed ? (
          <p style={{ marginTop: 12, fontSize: 13, color: '#8b93a7' }}>
            Answer locked — waiting for the reveal.
          </p>
        ) : null}
        {isHost ? (
          <button
            onClick={() => dispatch({ type: revealed ? 'next' : 'reveal' })}
            style={{
              marginTop: 16, padding: '10px 24px', borderRadius: 8,
              background: '#8fb8ff', color: '#070a0f', border: 'none',
              fontWeight: 600, cursor: 'pointer', width: '100%',
            }}
          >
            {revealed ? 'Next Question →' : 'Reveal Answer'}
          </button>
        ) : null}
      </div>
    );
  },
};
