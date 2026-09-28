/**
 * The "paste your own questions" format, parsed in the host's panel before
 * anything is sent. The server validates again (`quizValidateAction`), so
 * this is about helpful errors, not trust.
 *
 *   Which planet is closest to the Sun?
 *   *Mercury
 *   Venus
 *   Mars
 *
 *   How many days are there in a leap year?
 *   365
 *   *366
 *
 * One question per block, blocks separated by a blank line. The first line
 * is the question, every other line an answer (2–6 of them), the right one
 * marked with a leading `*`. A leading "1." on the question and "A)" or "-"
 * on answers are tolerated. A JSON array in the legacy `set-questions`
 * shape (`[{ "question", "options", "correctIndex" }]`) works too.
 */

import { quizValidateAction } from './actions';
import { isRecord } from './guards';
import { QUIZ_MAX_OPTIONS, QUIZ_MAX_QUESTIONS, QUIZ_MAX_TEXT, QUIZ_MIN_OPTIONS, type QuizQuestion } from './state';

export type QuizParseErrorCode =
  | 'empty'
  | 'tooMany'
  | 'noQuestion'
  | 'tooFewOptions'
  | 'tooManyOptions'
  | 'noCorrect'
  | 'manyCorrect'
  | 'duplicateOption'
  | 'tooLong'
  | 'invalidJson';

export interface QuizParseError {
  code: QuizParseErrorCode;
  /** 1-based question number, when the problem is in one question. */
  question?: number;
}

export type QuizParseResult = { ok: true; questions: QuizQuestion[] } | { ok: false; error: QuizParseError };

const QUESTION_NUMBER = /^\d{1,3}[.)]\s+/;
/** "A) ", "b) ", "- ", "• " — not "A. ", which would eat initials such as "C. S. Lewis". */
const ANSWER_PREFIX = /^(?:[A-Fa-f]\)|[-•–])\s+/;
const CORRECT_MARK = /^\*\s*/;

function parseAnswer(raw: string): { text: string; correct: boolean } {
  let line = raw;
  let correct = false;
  if (CORRECT_MARK.test(line)) {
    correct = true;
    line = line.replace(CORRECT_MARK, '');
  }
  line = line.replace(ANSWER_PREFIX, '');
  if (!correct && CORRECT_MARK.test(line)) {
    correct = true;
    line = line.replace(CORRECT_MARK, '');
  }
  return { text: line.trim(), correct };
}

function parseJson(text: string): QuizParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: 'invalidJson' } };
  }
  if (!Array.isArray(data)) return { ok: false, error: { code: 'invalidJson' } };
  if (data.length > QUIZ_MAX_QUESTIONS) return { ok: false, error: { code: 'tooMany' } };
  const questions: QuizQuestion[] = data.map((item) =>
    isRecord(item)
      ? { question: item.question as string, options: item.options as string[], correctIndex: item.correctIndex as number }
      : (item as QuizQuestion)
  );
  if (quizValidateAction({ type: 'set-questions', questions }) !== null) {
    return { ok: false, error: { code: 'invalidJson' } };
  }
  return { ok: true, questions };
}

export function parseCustomQuestions(text: string): QuizParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: { code: 'empty' } };
  if (trimmed.startsWith('[')) return parseJson(trimmed);

  const blocks = trimmed
    .split(/\r?\n[ \t]*\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    )
    .filter((lines) => lines.length > 0);
  if (blocks.length > QUIZ_MAX_QUESTIONS) return { ok: false, error: { code: 'tooMany' } };

  const questions: QuizQuestion[] = [];
  for (const [index, lines] of blocks.entries()) {
    const number = index + 1;
    const question = lines[0]!.replace(QUESTION_NUMBER, '').trim();
    if (!question || CORRECT_MARK.test(question)) return { ok: false, error: { code: 'noQuestion', question: number } };
    const answers = lines
      .slice(1)
      .map(parseAnswer)
      .filter((answer) => answer.text.length > 0);
    if (answers.length < QUIZ_MIN_OPTIONS) return { ok: false, error: { code: 'tooFewOptions', question: number } };
    if (answers.length > QUIZ_MAX_OPTIONS) return { ok: false, error: { code: 'tooManyOptions', question: number } };
    const correct = answers.filter((answer) => answer.correct).length;
    if (correct === 0) return { ok: false, error: { code: 'noCorrect', question: number } };
    if (correct > 1) return { ok: false, error: { code: 'manyCorrect', question: number } };
    if (question.length > QUIZ_MAX_TEXT || answers.some((answer) => answer.text.length > QUIZ_MAX_TEXT)) {
      return { ok: false, error: { code: 'tooLong', question: number } };
    }
    const keys = answers.map((answer) => answer.text.toLowerCase());
    if (new Set(keys).size !== keys.length) return { ok: false, error: { code: 'duplicateOption', question: number } };
    questions.push({
      question,
      options: answers.map((answer) => answer.text),
      correctIndex: answers.findIndex((answer) => answer.correct),
    });
  }
  return { ok: true, questions };
}
