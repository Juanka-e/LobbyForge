/** Test helpers: a controllable clock, a seeded random source, a reducer shortcut. */

import { quizReducer, type QuizEnv } from '../actions';
import { hydrateQuizPackStart } from '../packs/server';
import { createQuizInitialState, type QuizAction, type QuizQuestion, type QuizStartAction, type QuizState } from '../state';

export const T0 = 1_760_000_000_000;

/** mulberry32 — small, fast and deterministic. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Clock {
  t = T0;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
    return this;
  }
}

export function makeEnv(clock = new Clock(), random: () => number = seeded(42)): QuizEnv & { clock: Clock } {
  return { now: clock.now, random, clock };
}

export function run(state: QuizState, actions: QuizAction[], env: QuizEnv): QuizState {
  return actions.reduce((s, action) => quizReducer(s, action, env), state);
}

export const QUESTIONS: QuizQuestion[] = [
  { question: '2 + 2 = ?', options: ['3', '4', '5'], correctIndex: 1 },
  { question: 'Capital of Türkiye?', options: ['Istanbul', 'Ankara', 'Izmir'], correctIndex: 1 },
  { question: 'Largest ocean?', options: ['Atlantic', 'Indian', 'Pacific', 'Arctic'], correctIndex: 2 },
];

/**
 * A pack `start` as the reducer receives it: hydrated by the host's
 * server-side step (the client only ever sends the pack id and settings).
 */
export function packStart(fields: Omit<QuizStartAction, 'type' | 'source' | 'questions'>): QuizStartAction {
  const result = hydrateQuizPackStart({ type: 'start', source: 'pack', ...fields });
  if (!result.ok) throw new Error(`unknown pack ${fields.packId}:${fields.language}`);
  return result.action as QuizStartAction;
}

/** A lobby with the host (`host`) and the given players joined. */
export function lobbyWith(...players: string[]): QuizState {
  let state = createQuizInitialState('host');
  for (const id of players) state = quizReducer(state, { type: 'join', playerId: id });
  return state;
}

/** A custom game in order (shuffle off), 20 s per question, first question open at T0. */
export function customGame(players: string[], env: QuizEnv, questions: QuizQuestion[] = QUESTIONS): QuizState {
  return quizReducer(
    lobbyWith(...players),
    { type: 'start', source: 'custom', questions, questionCount: 5, secondsPerQuestion: 20, shuffle: false },
    env
  );
}
