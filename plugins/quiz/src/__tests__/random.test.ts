import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUIZ_DEFAULT_ENV } from '../actions';
import { buildDeck } from '../deck';
import { secureRandom } from '../random';
import type { QuizDeckQuestion } from '../state';

/**
 * Security follow-up: the question order and every question's option order
 * come from the platform CSPRNG, never `Math.random` — the built-in packs
 * are public, so a recoverable PRNG would let a player predict where the
 * correct answer lands.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

describe('quiz randomness', () => {
  it('secureRandom returns floats in [0, 1) from crypto.getRandomValues', () => {
    const crypto = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const math = vi.spyOn(Math, 'random');
    for (let i = 0; i < 200; i += 1) {
      const value = secureRandom();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(crypto).toHaveBeenCalledTimes(200);
    expect(math).not.toHaveBeenCalled();
  });

  it('the production env uses the CSPRNG', () => {
    expect(QUIZ_DEFAULT_ENV.random).toBe(secureRandom);
  });

  it('building a deck with the production env never calls Math.random', () => {
    const math = vi.spyOn(Math, 'random');
    const crypto = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const questions = Array.from({ length: 6 }, (_, i) => ({
      id: `q${i}`,
      prompt: `Question ${i}`,
      options: ['a', 'b', 'c', 'd'],
      correctIndex: i % 4,
    })) as unknown as QuizDeckQuestion[];
    const deck = buildDeck(questions, questions.length, true, QUIZ_DEFAULT_ENV.random);
    expect(deck).toHaveLength(questions.length);
    expect(math).not.toHaveBeenCalled();
    expect(crypto).toHaveBeenCalled();
  });
});
