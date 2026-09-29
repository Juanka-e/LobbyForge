/**
 * Building a game's deck. Randomness comes from the `random` function the
 * REDUCER passes in — `Math.random` on the server in production (the host
 * runs every action server-side), a seeded stub in tests. No action field
 * can influence it: a client cannot pick, order or peek at the deck.
 */

import type { QuizDeckQuestion } from './state';

/** Fisher–Yates on a copy. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    // Clamp: a stubbed `random` that returns 1 must not index past the end.
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The same question with its answers in a new order; `correctIndex` follows the right answer. */
export function shuffleOptions(question: QuizDeckQuestion, random: () => number): QuizDeckQuestion {
  const order = shuffled(
    question.options.map((_, index) => index),
    random
  );
  return {
    ...question,
    options: order.map((index) => question.options[index]!),
    correctIndex: order.indexOf(question.correctIndex),
  };
}

/**
 * Pick `count` questions from `pool`. With shuffle on: a random subset in
 * a random order, answers shuffled too. With shuffle off: the first
 * `count` questions exactly as written.
 */
export function buildDeck(
  pool: readonly QuizDeckQuestion[],
  count: number,
  shuffle: boolean,
  random: () => number
): QuizDeckQuestion[] {
  const size = Math.max(0, Math.min(Math.trunc(count), pool.length));
  if (!shuffle) return pool.slice(0, size).map((question) => ({ ...question, options: [...question.options] }));
  return shuffled(pool, random)
    .slice(0, size)
    .map((question) => shuffleOptions(question, random));
}
