import { describe, expect, it } from 'vitest';
import { quizValidateAction } from '../actions';
import { QUIZ_PACK_CATALOG, QUIZ_PACK_ORDER, defaultQuizPack, findQuizPackSummary, quizPacksForLocale } from '../packs';
import { QUIZ_PACKS, findQuizPack, hydrateQuizPackStart, quizPackQuestions } from '../packs/server';

/**
 * Pack integrity. The facts themselves were checked by hand (see
 * docs/QUIZ.md → "Adding a pack"); these tests keep the SHAPE honest so a
 * typo cannot ship a question with no right answer, two identical answers
 * or a pack that exists in one language only — and keep the client-safe
 * catalogue in step with the server-only questions.
 */

const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
const languages = [...new Set(QUIZ_PACKS.map((pack) => pack.language))].sort();

describe('built-in packs (server-only data)', () => {
  it('ship English and Turkish', () => {
    expect(languages).toEqual(['en', 'tr']);
  });

  it('every language has the same pack ids', () => {
    const idsOf = (language: string) =>
      QUIZ_PACKS.filter((pack) => pack.language === language)
        .map((pack) => pack.id)
        .sort();
    for (const language of languages) expect(idsOf(language), language).toEqual([...QUIZ_PACK_ORDER].sort());
  });

  it('no pack is listed twice', () => {
    const keys = QUIZ_PACKS.map((pack) => `${pack.id}:${pack.language}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe.each(QUIZ_PACKS.map((pack) => [`${pack.id} (${pack.language})`, pack] as const))('%s', (_name, pack) => {
    it('has a title, a description and at least 20 questions', () => {
      expect(pack.title.trim()).toBeTruthy();
      expect(pack.description.trim()).toBeTruthy();
      expect(pack.questions.length).toBeGreaterThanOrEqual(20);
    });

    it('every question has four different answers and one valid right answer', () => {
      for (const question of pack.questions) {
        expect(question.options, question.id).toHaveLength(4);
        expect(question.options.every((option) => option.trim().length > 0 && option === option.trim()), question.id).toBe(true);
        expect(new Set(question.options.map(normalize)).size, question.id).toBe(4);
        expect(Number.isInteger(question.correctIndex), question.id).toBe(true);
        expect(question.correctIndex, question.id).toBeGreaterThanOrEqual(0);
        expect(question.correctIndex, question.id).toBeLessThan(4);
      }
    });

    it('questions read as questions and fit the answer tiles', () => {
      for (const question of pack.questions) {
        expect(question.question.trim(), question.id).toBe(question.question);
        expect(question.question.endsWith('?'), question.id).toBe(true);
        expect(question.question.length, question.id).toBeLessThanOrEqual(120);
        for (const option of question.options) expect(option.length, `${question.id}: ${option}`).toBeLessThanOrEqual(40);
      }
    });

    it('ids follow `<pack>-<language>-NN`', () => {
      const prefix = `${pack.id.slice(0, 3)}-${pack.language}-`;
      for (const question of pack.questions) expect(question.id).toMatch(new RegExp(`^${prefix}\\d{2}$`));
    });

    it('has no duplicate questions', () => {
      const texts = pack.questions.map((question) => normalize(question.question));
      expect(new Set(texts).size).toBe(texts.length);
    });

    it('spreads the right answer over A–D, so shuffle-off games have no pattern', () => {
      const counts = [0, 0, 0, 0];
      for (const question of pack.questions) counts[question.correctIndex]! += 1;
      for (const count of counts) expect(count).toBeGreaterThanOrEqual(Math.floor(pack.questions.length / 4) - 1);
    });

    it('passes the same validation as a pasted question', () => {
      const questions = pack.questions.map((question) => ({
        question: question.question,
        options: [...question.options],
        correctIndex: question.correctIndex,
      }));
      expect(quizValidateAction({ type: 'start', source: 'custom', questions })).toBeNull();
    });
  });

  it('question ids are unique across every pack', () => {
    const ids = QUIZ_PACKS.flatMap((pack) => pack.questions.map((question) => question.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no question is repeated across packs of the same language', () => {
    for (const language of languages) {
      const texts = QUIZ_PACKS.filter((pack) => pack.language === language).flatMap((pack) =>
        pack.questions.map((question) => normalize(question.question))
      );
      expect(new Set(texts).size, language).toBe(texts.length);
    }
  });
});

describe('the client-safe catalogue matches the server-only questions', () => {
  it('lists exactly the packs the server has, with the right counts and titles', () => {
    expect(QUIZ_PACK_CATALOG.map((p) => [p.id, p.language, p.title, p.description, p.questionCount])).toEqual(
      QUIZ_PACKS.map((p) => [p.id, p.language, p.title, p.description, p.questions.length])
    );
  });

  it('carries no questions, and so no answers', () => {
    const json = JSON.stringify(QUIZ_PACK_CATALOG);
    expect(json).not.toContain('correctIndex');
    expect(json).not.toContain('options');
    for (const pack of QUIZ_PACKS) expect(json).not.toContain(pack.questions[0]!.question);
  });
});

describe('pack lookup and ordering', () => {
  it('finds a pack by id AND language', () => {
    expect(findQuizPackSummary('general', 'tr')?.title).toBe('Genel Kültür');
    expect(findQuizPackSummary('general', 'en')?.title).toBe('General Knowledge');
    expect(findQuizPackSummary('general', 'de')).toBeNull();
    expect(findQuizPackSummary('nope', 'en')).toBeNull();
    expect(findQuizPackSummary(null, 'en')).toBeNull();
    expect(findQuizPack('science', 'tr')?.questions).toHaveLength(24);
    expect(findQuizPack(42, 'tr')).toBeNull();
  });

  it('lists the viewer’s language first, in the pack order', () => {
    expect(quizPacksForLocale('tr').map((pack) => `${pack.id}:${pack.language}`)).toEqual([
      'general:tr',
      'science:tr',
      'geography:tr',
      'general:en',
      'science:en',
      'geography:en',
    ]);
    expect(quizPacksForLocale('en').slice(0, 3).every((pack) => pack.language === 'en')).toBe(true);
    expect(quizPacksForLocale('tr-TR')[0]!.language).toBe('tr');
  });

  it('falls back to the first language for one without packs', () => {
    expect(quizPacksForLocale('de')[0]!.language).toBe('en');
    expect(defaultQuizPack('de')).toMatchObject({ id: 'general', language: 'en' });
    expect(defaultQuizPack('tr')).toMatchObject({ id: 'general', language: 'tr' });
  });
});

describe('hydrateQuizPackStart — the host’s server-side step', () => {
  it('injects the pack’s questions into a pack `start`, keeping the settings', () => {
    const result = hydrateQuizPackStart({ type: 'start', source: 'pack', packId: 'geography', language: 'tr', questionCount: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toMatchObject({ type: 'start', source: 'pack', packId: 'geography', language: 'tr', questionCount: 5 });
    expect(result.action.questions).toEqual(quizPackQuestions('geography', 'tr'));
    expect((result.action.questions as unknown[]).length).toBe(24);
    // The hydrated action is exactly what the plugin validates and plays.
    expect(quizValidateAction(result.action)).toBeNull();
  });

  it('replaces questions a client sent for a pack game', () => {
    const forged = [{ question: 'Pick A?', options: ['A', 'B'], correctIndex: 0 }];
    const result = hydrateQuizPackStart({ type: 'start', source: 'pack', packId: 'general', language: 'en', questions: forged });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.questions).not.toEqual(forged);
    expect(JSON.stringify(result.action.questions)).not.toContain('Pick A?');
    expect((result.action.questions as Array<{ id: string }>)[0]!.id).toBe('gen-en-01');
  });

  it('answers 404 for an unknown pack', () => {
    for (const action of [
      { type: 'start', source: 'pack', packId: 'nope', language: 'en' },
      { type: 'start', source: 'pack', packId: 'general', language: 'de' },
      { type: 'start', source: 'pack' },
    ]) {
      expect(hydrateQuizPackStart(action)).toEqual({ ok: false, status: 404, error: 'Question pack not found' });
    }
  });

  it('leaves custom games and every other action alone', () => {
    const custom = { type: 'start', source: 'custom', questions: [{ question: 'Q?', options: ['a', 'b'], correctIndex: 1 }] };
    expect(hydrateQuizPackStart(custom)).toEqual({ ok: true, action: custom });
    for (const action of [{ type: 'answer', index: 1 }, { type: 'next' }, { type: 'set-questions', questions: [] }]) {
      expect(hydrateQuizPackStart(action)).toEqual({ ok: true, action });
    }
  });
});
