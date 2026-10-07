import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG_NAME_KEY, CATALOG_SUMMARY_KEY, formatMessage, messageArguments } from '@lobbyforge/plugin-sdk';
import { SHIPPED_LOCALES } from '../locales.generated';

/**
 * Watch Party's translation tables, checked against the panel that renders
 * them and against English.
 *
 * The languages are read from `locales/`, so a new `locales/<code>.json`
 * (scaffolded by `pnpm i18n:add`) is held to these rules the moment it
 * exists. A file marked `"$status": "partial"` may have blanks — they fall
 * back to English — but never a key English lacks or different arguments.
 *
 * A missing translation is SILENT by design (the lookup falls back), so
 * only a test notices one.
 */

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

type Table = Record<string, string>;
const load = (code: string): Table =>
  JSON.parse(readFileSync(join(ROOT, 'locales', `${code}.json`), 'utf8')) as Table;
/** `$`-prefixed entries are file metadata (`$status`), not strings. */
const strings = (table: Table): Table =>
  Object.fromEntries(Object.entries(table).filter(([key]) => !key.startsWith('$')));
/** Argument names, as the SDK's formatter sees them: `{count, plural, …}` and `{count}` agree. */
const args = (text: string) => messageArguments(text).join(',');

const onDisk = readdirSync(join(ROOT, 'locales'))
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length))
  .sort();
const english = strings(load('en'));

/** Every source file of the panel (not the tests). */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Every `t('watchParty.…')` key the panel renders. */
const used = [
  ...new Set(
    sourceFiles(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\bt\(\s*'(watchParty\.[^']+)'/g)].map((match) => match[1]!)
    )
  ),
].sort();

describe('Watch Party locales', () => {
  it('finds the keys the panel uses', () => {
    expect(used.length).toBeGreaterThan(60);
    expect(used).toContain('watchParty.controls.play');
    expect(used).toContain('watchParty.stage.joinTitle');
    expect(used).toContain('watchParty.copyright');
  });

  it('ships every language on disk, English first', () => {
    expect(SHIPPED_LOCALES).toEqual(['en', ...onDisk.filter((code) => code !== 'en')]);
  });

  it('translates its catalogue summary, which the host shows', () => {
    expect(english[CATALOG_SUMMARY_KEY]?.trim()).toBeTruthy();
    expect(english[CATALOG_NAME_KEY]?.trim()).toBeTruthy();
  });

  it('has English for every key the panel renders', () => {
    expect(used.filter((key) => !english[key]?.trim())).toEqual([]);
  });

  it('ships no key the panel never renders', () => {
    expect(Object.keys(english).filter((key) => !used.includes(key) && key !== CATALOG_SUMMARY_KEY && key !== CATALOG_NAME_KEY)).toEqual([]);
  });

  it('writes counts as plurals in English', () => {
    for (const key of Object.keys(english)) {
      if (messageArguments(english[key]!).includes('count')) {
        expect(english[key], key).toMatch(/\{count, plural,/);
      }
    }
    expect(formatMessage(english['watchParty.header.watching']!, { count: 1 }, 'en')).toBe('1 person watching');
    expect(formatMessage(english['watchParty.header.watching']!, { count: 6 }, 'en')).toBe('6 people watching');
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
});
