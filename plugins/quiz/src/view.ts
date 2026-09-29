/**
 * The panel's defensive read of the state it is handed. The host passes the
 * PROJECTED state (see `QuizViewState`); this fills anything missing so a
 * half-written or unexpected blob renders as a lobby instead of crashing
 * the room.
 */

import { isFiniteNumber, isRecord } from './guards';
import {
  QUIZ_STATE_VERSION,
  defaultQuizSettings,
  newQuizPlayer,
  type QuizPhase,
  type QuizPlayer,
  type QuizPublicQuestion,
  type QuizReveal,
  type QuizRoundResult,
  type QuizViewState,
} from './state';

const PHASES: readonly QuizPhase[] = ['lobby', 'playing', 'reveal', 'ended'];
const RESULTS: readonly QuizRoundResult[] = ['correct', 'wrong', 'missed'];

const num = (value: unknown, fallback = 0) => (isFiniteNumber(value) ? value : fallback);
const numOrNull = (value: unknown) => (isFiniteNumber(value) ? value : null);

function toPlayer(raw: unknown): QuizPlayer | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) return null;
  const base = newQuizPlayer(raw.id, typeof raw.name === 'string' ? raw.name : null, num(raw.eligibleFrom));
  return {
    ...base,
    active: raw.active !== false,
    score: num(raw.score),
    correct: num(raw.correct),
    answered: num(raw.answered),
    streak: num(raw.streak),
    bestStreak: num(raw.bestStreak),
    lastGain: num(raw.lastGain),
    lastResult: RESULTS.includes(raw.lastResult as QuizRoundResult) ? (raw.lastResult as QuizRoundResult) : null,
  };
}

function toQuestion(raw: unknown): QuizPublicQuestion | null {
  if (!isRecord(raw) || typeof raw.question !== 'string' || !Array.isArray(raw.options)) return null;
  return {
    index: num(raw.index),
    question: raw.question,
    options: raw.options.filter((option): option is string => typeof option === 'string'),
  };
}

function toReveal(raw: unknown): QuizReveal | null {
  if (!isRecord(raw) || !Array.isArray(raw.counts) || !isFiniteNumber(raw.correctIndex)) return null;
  return {
    index: num(raw.index),
    correctIndex: raw.correctIndex,
    counts: raw.counts.map((count) => num(count)),
    answered: num(raw.answered),
    correct: num(raw.correct),
  };
}

export function toQuizView(raw: unknown): QuizViewState {
  const s = isRecord(raw) ? raw : {};
  const phase = PHASES.includes(s.phase as QuizPhase) ? (s.phase as QuizPhase) : 'lobby';
  const players = Array.isArray(s.players) ? s.players.map(toPlayer).filter((p): p is QuizPlayer => p !== null) : [];
  const current = toQuestion(s.current);
  return {
    version: num(s.version, QUIZ_STATE_VERSION),
    // A question phase without a question to show is not something we can render.
    phase: (phase === 'playing' || phase === 'reveal') && !current ? 'lobby' : phase,
    settings: { ...defaultQuizSettings(), ...(isRecord(s.settings) ? s.settings : {}) },
    players,
    questionTotal: num(s.questionTotal),
    questionsRevealed: num(s.questionsRevealed),
    currentIndex: num(s.currentIndex),
    current,
    questionStartedAt: numOrNull(s.questionStartedAt),
    deadline: numOrNull(s.deadline),
    reveal: toReveal(s.reveal),
    startedAt: numOrNull(s.startedAt),
    endedAt: numOrNull(s.endedAt),
    endReason: s.endReason === 'completed' || s.endReason === 'host' ? s.endReason : null,
    answeredCount: num(s.answeredCount),
    myAnswer: isFiniteNumber(s.myAnswer) && Number.isInteger(s.myAnswer) && s.myAnswer >= 0 ? s.myAnswer : null,
  };
}
