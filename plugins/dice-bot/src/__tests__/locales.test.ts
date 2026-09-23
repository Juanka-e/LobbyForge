import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG_SUMMARY_KEY } from '@lobbyforge/plugin-sdk';
import { SHIPPED_LOCALES } from '../locales.generated';

/**
 * Dice Bot's translation tables, checked against the panel that renders
 * them and against English.
 *
 * The languages are read from `locales/`, not listed here, so a new
 * `locales/<code>.json` (scaffolded by `pnpm i18n:add`) is held to these
 * rules the moment it exists. A file marked `"$status": "partial"` may
 * have blanks — they fall back to English at runtime — but it may never
 * carry a key English lacks or change a placeholder.
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
const placeholders = (text: string) => (text.match(/\{(\w+)\}/g) ?? []).sort().join();

const onDisk = readdirSync(join(ROOT, 'locales'))
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length))
  .sort();
const english = strings(load('en'));

/** Every `t('dice.…')` key the panel renders. */
const used = [
  ...new Set(
    [...readFileSync(join(ROOT, 'src', 'renderClient.tsx'), 'utf8').matchAll(
      /\bt\(\s*'(dice\.[^']+)'/g
    )].map((match) => match[1]!)
  ),
].sort();

describe('Dice Bot locales', () => {
  it('finds the keys the panel uses', () => {
    expect(used.length).toBeGreaterThan(10);
    expect(used).toContain('dice.roll.button');
    expect(used).toContain('dice.stats.heading');
    expect(used).toContain('dice.host.reset');
  });

  it('ships every language on disk, English first', () => {
    // The generated index (`pnpm i18n:sync`) is what the manifest and the
    // loader read; it must list exactly the files that exist.
    expect(SHIPPED_LOCALES).toEqual(['en', ...onDisk.filter((code) => code !== 'en')]);
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

  describe.each(onDisk.filter((code) => code !== 'en'))('%s', (code) => {
    const table = load(code);
    const messages = strings(table);

    it('defines no key that English does not have', () => {
      expect(Object.keys(messages).filter((key) => !(key in english))).toEqual([]);
    });

    it('uses exactly the placeholders English uses', () => {
      const mismatched = Object.entries(messages)
        .filter(([key, value]) => value.trim() && key in english)
        .filter(([key, value]) => placeholders(value) !== placeholders(english[key]!))
        .map(([key]) => key);
      expect(mismatched).toEqual([]);
    });

    if (table.$status !== 'partial') {
      it('translates every key, because it is not marked partial', () => {
        expect(Object.keys(english).filter((key) => !messages[key]?.trim())).toEqual([]);
      });
    }
  });
});
