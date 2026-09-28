/**
 * Pure helpers over the player list, shared by the reducer and the panel
 * (the panel only has the projected state, so these take plain fields).
 */

import type { QuizPlayer } from './state';

/** May this player answer question `index`? */
export function isEligible(player: QuizPlayer, index: number): boolean {
  return player.active && player.eligibleFrom <= index;
}

export function eligiblePlayers(players: readonly QuizPlayer[], index: number): QuizPlayer[] {
  return players.filter((player) => isEligible(player, index));
}

export interface RankedQuizPlayer {
  player: QuizPlayer;
  /** 1-based. Equal scores share a rank (1, 2, 2, 4). */
  rank: number;
}

/**
 * The leaderboard: score, then correct answers, then join order. Players
 * who could never answer a question of this game (they joined after the
 * last one) are left out; everyone else stays, including those who left.
 */
export function rankQuizPlayers(players: readonly QuizPlayer[], questionTotal?: number): RankedQuizPlayer[] {
  const order = new Map(players.map((player, index) => [player.id, index]));
  const shown =
    typeof questionTotal === 'number' && questionTotal > 0
      ? players.filter((player) => player.eligibleFrom < questionTotal)
      : [...players];
  const sorted = shown.sort(
    (a, b) => b.score - a.score || b.correct - a.correct || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
  );
  const ranked: RankedQuizPlayer[] = [];
  sorted.forEach((player, index) => {
    const previous = ranked[index - 1];
    const rank = previous && previous.player.score === player.score ? previous.rank : index + 1;
    ranked.push({ player, rank });
  });
  return ranked;
}

/** The podium: places 1–3, each holding everyone tied on it (empty places are dropped). */
export function quizPodium(ranked: readonly RankedQuizPlayer[]): Array<{ place: 1 | 2 | 3; players: QuizPlayer[] }> {
  const places: Array<{ place: 1 | 2 | 3; players: QuizPlayer[] }> = [];
  for (const place of [1, 2, 3] as const) {
    const holders = ranked.filter((entry) => entry.rank === place).map((entry) => entry.player);
    if (holders.length > 0) places.push({ place, players: holders });
  }
  return places;
}
