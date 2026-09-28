/**
 * `@lobbyforge/quiz/packs` — SERVER ONLY.
 *
 * The built-in packs WITH their questions and answers. The host imports this
 * on the server (apps/web/lib/prepare-plugin-action.ts) to hydrate a pack
 * game's `start` action before the reducer runs — the same pattern Hushle
 * uses for its DB decks. Nothing the panel or the plugin's main entry
 * imports may reach this file (__tests__/client-bundle.test.ts), so the
 * answers never ship to browsers.
 */

import type { QuizQuestion } from '../state';
import { QUIZ_PACK_CATALOG, type QuizPackSummary } from './catalog';
import { generalEnQuestions } from './data/general.en';
import { generalTrQuestions } from './data/general.tr';
import { geographyEnQuestions } from './data/geography.en';
import { geographyTrQuestions } from './data/geography.tr';
import { scienceEnQuestions } from './data/science.en';
import { scienceTrQuestions } from './data/science.tr';
import type { QuizPack, QuizPackQuestion } from './types';

export type { QuizPack, QuizPackQuestion } from './types';
export type { QuizPackSummary } from './catalog';

const QUESTIONS: Record<string, readonly QuizPackQuestion[]> = {
  'general:en': generalEnQuestions,
  'science:en': scienceEnQuestions,
  'geography:en': geographyEnQuestions,
  'general:tr': generalTrQuestions,
  'science:tr': scienceTrQuestions,
  'geography:tr': geographyTrQuestions,
};

const keyOf = (pack: Pick<QuizPackSummary, 'id' | 'language'>) => `${pack.id}:${pack.language}`;

/** Every built-in pack: the catalogue entry plus its questions. */
export const QUIZ_PACKS: readonly QuizPack[] = QUIZ_PACK_CATALOG.map((pack) => ({
  id: pack.id,
  language: pack.language,
  title: pack.title,
  description: pack.description,
  questions: QUESTIONS[keyOf(pack)] ?? [],
}));

export function findQuizPack(id: unknown, language: unknown): QuizPack | null {
  if (typeof id !== 'string' || typeof language !== 'string') return null;
  return QUIZ_PACKS.find((pack) => pack.id === id && pack.language === language) ?? null;
}

/** A pack's questions in the shape the reducer takes (`start.questions`), or null for an unknown pack. */
export function quizPackQuestions(id: unknown, language: unknown): QuizQuestion[] | null {
  const pack = findQuizPack(id, language);
  if (!pack || pack.questions.length === 0) return null;
  return pack.questions.map((question) => ({
    id: question.id,
    question: question.question,
    options: [...question.options],
    correctIndex: question.correctIndex,
  }));
}

export type QuizPreparedAction =
  | { ok: true; action: Record<string, unknown> }
  | { ok: false; status: 404; error: string };

/**
 * The host's hydration step for Quiz. A `start` from a pack gets the pack's
 * questions, loaded here on the server; whatever the client put in
 * `questions` is replaced — a pack game only ever plays the pack. An
 * unknown pack is a 404. Every other action (custom questions included,
 * which the plugin validates) passes through untouched.
 */
export function hydrateQuizPackStart(action: Record<string, unknown>): QuizPreparedAction {
  if (action.type !== 'start' || action.source !== 'pack') return { ok: true, action };
  const questions = quizPackQuestions(action.packId, action.language);
  if (!questions) return { ok: false, status: 404, error: 'Question pack not found' };
  return { ok: true, action: { ...action, questions } };
}
