/**
 * The built-in packs' CATALOGUE — what the setup screen lists — and nothing
 * else: no question text, no answers. Client-safe.
 *
 * The questions live in ./data and are reachable only through ./server.ts
 * (the `@lobbyforge/quiz/packs` subpath), which the host imports on the
 * server to hydrate a pack game's `start` action. `questionCount` must match
 * the data; the packs test checks it.
 *
 * A pack is identified by its `id` AND its `language`: `general` exists in
 * English and in Turkish, written separately (the Turkish packs are for
 * Turkish players, not translations). Every language ships the same ids.
 */

import type { QuizPackId } from './types';

/** A pack without its questions. */
export interface QuizPackSummary {
  id: QuizPackId;
  /** The language the questions are written in (a BCP 47 code). */
  language: string;
  /** In the pack's own language. */
  title: string;
  description: string;
  questionCount: number;
}

/** Display order within a language. */
export const QUIZ_PACK_ORDER = ['general', 'science', 'geography'] as const;

export const QUIZ_PACK_CATALOG: readonly QuizPackSummary[] = [
  {
    id: 'general',
    language: 'en',
    title: 'General Knowledge',
    description: 'A bit of everything: art, books, music, sport and history.',
    questionCount: 24,
  },
  {
    id: 'science',
    language: 'en',
    title: 'Science & Nature',
    description: 'Planets, the human body, chemistry and the natural world.',
    questionCount: 24,
  },
  {
    id: 'geography',
    language: 'en',
    title: 'Geography',
    description: 'Capitals, rivers, mountains and oceans around the world.',
    questionCount: 24,
  },
  {
    id: 'general',
    language: 'tr',
    title: 'Genel Kültür',
    description: 'Edebiyat, tarih, sanat, spor… Biraz ondan, biraz bundan.',
    questionCount: 24,
  },
  {
    id: 'science',
    language: 'tr',
    title: 'Bilim ve Doğa',
    description: 'Gezegenler, insan vücudu, kimya ve doğa dünyası.',
    questionCount: 24,
  },
  {
    id: 'geography',
    language: 'tr',
    title: 'Coğrafya',
    description: 'Türkiye’den dünyaya: dağlar, göller, başkentler ve okyanuslar.',
    questionCount: 24,
  },
];

export function findQuizPackSummary(
  id: string | null | undefined,
  language: string | null | undefined
): QuizPackSummary | null {
  if (!id || !language) return null;
  return QUIZ_PACK_CATALOG.find((pack) => pack.id === id && pack.language === language) ?? null;
}

function baseLanguage(locale: string | null | undefined): string {
  return (locale ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
}

/**
 * Every pack, the viewer's language first, then the others; within a
 * language, `QUIZ_PACK_ORDER`.
 */
export function quizPacksForLocale(locale: string | null | undefined): QuizPackSummary[] {
  const mine = baseLanguage(locale);
  const order = (id: string) => {
    const index = (QUIZ_PACK_ORDER as readonly string[]).indexOf(id);
    return index < 0 ? QUIZ_PACK_ORDER.length : index;
  };
  const languages = [...new Set(QUIZ_PACK_CATALOG.map((pack) => pack.language))];
  const rank = (language: string) => (language === mine ? -1 : languages.indexOf(language));
  return [...QUIZ_PACK_CATALOG].sort((a, b) => rank(a.language) - rank(b.language) || order(a.id) - order(b.id));
}

/** The first pack in the viewer's language (or the first pack of all). */
export function defaultQuizPack(locale: string | null | undefined): QuizPackSummary {
  return quizPacksForLocale(locale)[0]!;
}
