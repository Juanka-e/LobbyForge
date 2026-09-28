import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG_SUMMARY_KEY, formatMessage, messageArguments } from '@lobbyforge/plugin-sdk';
import { SHIPPED_LOCALES } from '../locales.generated';

/**
 * Quiz's translation tables, checked against the panel that renders them
 * and against English.
 *
 * The languages are read from `locales/`, not listed here, so a new
 * `locales/<code>.json` (scaffolded by `pnpm i18n:add`) is held to these
 * rules the moment it exists. A file marked `"$status": "partial"` may
 * have blanks — they fall back to English at runtime — but it may never
 * carry a key English lacks or change an argument.
 *
 * A missing translation is SILENT by design (the lookup falls back), so
 * only a test notices one. That is the whole reason this file exists.
 */

const ROOT = join(__dirname, '..', '..');

type Table = Record<string, string>;
const load = (code: string): Table =>
  JSON.parse(readFileSync(join(ROOT, 'locales', `${code}.json`), 'utf8')) as Table;
/** `$`-prefixed entries are file metadata (`$status`), not strings. */
const strings = (table: Table): Table =>
  Object.fromEntries(Object.entries(table).filter(([key]) => !key.startsWith('$')));
/** Argument names, plurals included — Turkish may write `{count} soru` where English pluralises. */
const args = (text: string) => messageArguments(text).join();

const onDisk = readdirSync(join(ROOT, 'locales'))
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length))
  .sort();
const english = strings(load('en'));

/** Every panel source file (the panel is split over several). */
function panelSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...panelSources(path));
    } else if (entry.name.endsWith('.tsx')) {
      out.push(path);
    }
  }
  return out;
}

/** Every `t('quiz.…')` key the panel renders. */
const used = [
  ...new Set(
    panelSources(join(ROOT, 'src')).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\bt\(\s*'(quiz\.[^']+)'/g)].map((match) => match[1]!)
    )
  ),
].sort();

describe('Quiz locales', () => {
  it('finds the keys the panel uses', () => {
    expect(used.length).toBeGreaterThan(40);
    expect(used).toContain('quiz.setup.start');
    expect(used).toContain('quiz.reveal.correctAnswer');
    expect(used).toContain('quiz.ended.place1');
  });

  it('ships every language on disk, English first', () => {
    // The generated index (`pnpm i18n:sync`) is what the manifest and the
    // loader read; it must list exactly the files that exist.
    expect(SHIPPED_LOCALES).toEqual(['en', ...onDisk.filter((code) => code !== 'en')]);
    expect(SHIPPED_LOCALES).toContain('tr');
  });

  it('translates its catalogue summary, which the host shows', () => {
    expect(english[CATALOG_SUMMARY_KEY]?.trim()).toBeTruthy();
  });

  it('has English for every key the panel renders', () => {
    expect(used.filter((key) => !english[key]?.trim())).toEqual([]);
  });

  it('ships no key the panel never renders', () => {
    // A key nobody renders is a translation cost with no payoff.
    // `catalog.summary` is rendered by the host (activity picker, admin list).
    expect(Object.keys(english).filter((key) => !used.includes(key) && key !== CATALOG_SUMMARY_KEY)).toEqual([]);
  });

  it('counts with plurals, not with a number glued to a noun', () => {
    for (const key of ['quiz.lobby.playerCount', 'quiz.question.timeLeft', 'quiz.reveal.picked', 'quiz.setup.packQuestions']) {
      expect(english[key], key).toMatch(/\{count, plural,/);
    }
    expect(formatMessage(english['quiz.lobby.playerCount']!, { count: 1 }, 'en')).toBe('1 player');
    expect(formatMessage(english['quiz.lobby.playerCount']!, { count: 3 }, 'en')).toBe('3 players');
    expect(formatMessage(english['quiz.reveal.picked']!, { count: 0 }, 'en')).toBe('No one');
    expect(formatMessage(english['quiz.reveal.summary']!, { answered: 3, correct: 2 }, 'en')).toBe(
      '2 of 3 players got it right.'
    );
  });

  describe.each(onDisk.filter((code) => code !== 'en'))('%s', (code) => {
    const table = load(code);
    const messages = strings(table);

    it('defines no key that English does not have', () => {
      expect(Object.keys(messages).filter((key) => !(key in english))).toEqual([]);
    });

    it('uses exactly the arguments English uses', () => {
      const mismatched = Object.entries(messages)
        .filter(([key, value]) => value.trim() && key in english)
        .filter(([key, value]) => args(value) !== args(english[key]!))
        .map(([key]) => key);
      expect(mismatched).toEqual([]);
    });

    if (table.$status !== 'partial') {
      it('translates every key, because it is not marked partial', () => {
        expect(Object.keys(english).filter((key) => !messages[key]?.trim())).toEqual([]);
      });
    }
  });

  it('reads naturally in Turkish (a spot check)', () => {
    const tr = strings(load('tr'));
    expect(formatMessage(tr['quiz.reveal.summary']!, { answered: 5, correct: 3 }, 'tr')).toBe('5 oyuncudan 3 kişi bildi.');
    expect(formatMessage(tr['quiz.question.timeLeft']!, { count: 1 }, 'tr')).toBe('1 saniye kaldı');
    expect(formatMessage(tr['quiz.reveal.picked']!, { count: 0 }, 'tr')).toBe('Kimse');
  });
});
