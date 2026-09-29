/** Built-in question packs — data only, no logic. */

export type QuizPackId = 'general' | 'science' | 'geography';

export interface QuizPackQuestion {
  /** Unique across every pack, e.g. `gen-en-07`. */
  id: string;
  question: string;
  /** Exactly four answers, one of them right. */
  options: readonly [string, string, string, string];
  correctIndex: 0 | 1 | 2 | 3;
}

export interface QuizPack {
  /** Shared by every language that ships this pack. */
  id: QuizPackId;
  /** The language the questions are written in (a BCP 47 code). */
  language: string;
  /** In the pack's own language. */
  title: string;
  description: string;
  questions: readonly QuizPackQuestion[];
}

/** Shorthand for pack files: `q('gen-en-01', 'Question?', ['A', 'B', 'C', 'D'], 1)`. */
export function q(
  id: string,
  question: string,
  options: [string, string, string, string],
  correctIndex: 0 | 1 | 2 | 3
): QuizPackQuestion {
  return { id, question, options, correctIndex };
}
