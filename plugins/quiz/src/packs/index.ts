/**
 * Client-safe pack API: the catalogue (titles, languages, counts) only.
 *
 * The questions and answers are NOT reachable from here — they live behind
 * the server-only `@lobbyforge/quiz/packs` subpath (./server.ts). Do not
 * re-export ./server or ./data from this file or from the plugin's main
 * entry: the panel is bundled for browsers, and a pack's answers would ship
 * with it. __tests__/client-bundle.test.ts fails if they become reachable.
 */

export {
  QUIZ_PACK_CATALOG,
  QUIZ_PACK_ORDER,
  defaultQuizPack,
  findQuizPackSummary,
  quizPacksForLocale,
  type QuizPackSummary,
} from './catalog';
export type { QuizPack, QuizPackId, QuizPackQuestion } from './types';
