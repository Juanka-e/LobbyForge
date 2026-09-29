import { describe, expect, it } from 'vitest';
import { eligiblePlayers, quizPodium, rankQuizPlayers } from '../roster';
import { newQuizPlayer, type QuizPlayer } from '../state';

const player = (id: string, overrides: Partial<QuizPlayer> = {}): QuizPlayer => ({ ...newQuizPlayer(id, null, 0), ...overrides });

describe('ranking', () => {
  it('orders by score, then correct answers, then join order; ties share a rank', () => {
    const ranked = rankQuizPlayers([
      player('a', { score: 900, correct: 1 }),
      player('b', { score: 1_500, correct: 2 }),
      player('c', { score: 900, correct: 2 }),
      player('d', { score: 200, correct: 1 }),
      player('e', { score: 900, correct: 1 }),
    ]);
    expect(ranked.map((entry) => [entry.player.id, entry.rank])).toEqual([
      ['b', 1],
      ['c', 2],
      ['a', 2],
      ['e', 2],
      ['d', 5],
    ]);
  });

  it('keeps players who left, drops those who could never answer', () => {
    const ranked = rankQuizPlayers(
      [player('a', { score: 500, active: false }), player('late', { eligibleFrom: 5 }), player('b')],
      5
    );
    expect(ranked.map((entry) => entry.player.id)).toEqual(['a', 'b']);
  });

  it('builds a podium of shared places, skipping empty ones', () => {
    const ranked = rankQuizPlayers([player('a', { score: 900 }), player('b', { score: 900 }), player('c', { score: 100 })]);
    expect(quizPodium(ranked).map((place) => [place.place, place.players.map((p) => p.id)])).toEqual([
      [1, ['a', 'b']],
      [3, ['c']],
    ]);
  });

  it('eligible players are the active ones who joined in time', () => {
    const players = [player('a'), player('b', { active: false }), player('c', { eligibleFrom: 2 })];
    expect(eligiblePlayers(players, 1).map((p) => p.id)).toEqual(['a']);
    expect(eligiblePlayers(players, 2).map((p) => p.id)).toEqual(['a', 'c']);
  });
});
