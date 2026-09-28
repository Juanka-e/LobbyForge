import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG_SUMMARY_KEY, formatMessage, messageArguments } from '@lobbyforge/plugin-sdk';
import { SHIPPED_LOCALES } from '../locales.generated';

/**
 * Vampire Village's translation tables, checked against the panel that
 * renders them and against English.
 *
 * The languages are read from `locales/`, not listed here, so a new
 * `locales/<code>.json` (scaffolded by `pnpm i18n:add`) is held to these
 * rules the moment it exists. A file marked `"$status": "partial"` may
 * have blanks — they fall back to English at runtime — but it may never
 * carry a key English lacks or change an argument.
 *
 * A missing translation is SILENT by design (the lookup falls back), so
 * only a test notices one.
 */

const ROOT = join(__dirname, '..', '..');

type Table = Record<string, string>;
const load = (code: string): Table =>
  JSON.parse(readFileSync(join(ROOT, 'locales', `${code}.json`), 'utf8')) as Table;
/** `$`-prefixed entries are file metadata (`$status`), not strings. */
const strings = (table: Table): Table =>
  Object.fromEntries(Object.entries(table).filter(([key]) => !key.startsWith('$')));
const args = (text: string) => [...messageArguments(text)].sort().join();

const onDisk = readdirSync(join(ROOT, 'locales'))
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length))
  .sort();
const english = strings(load('en'));

/** Every panel source file (not the tests). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

/**
 * Every key the panel can render. The panel never builds a key from a
 * template (see ui/labels.ts), so each one appears as a string literal.
 */
const used = [
  ...new Set(
    sources(join(ROOT, 'src')).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/'(vampire\.[A-Za-z0-9_.-]+)'/g)].map((match) => match[1]!)
    )
  ),
].sort();

describe('Vampire Village locales', () => {
  it('finds the keys the panel uses', () => {
    expect(used.length).toBeGreaterThan(200);
    expect(used).toContain('vampire.lobby.join');
    expect(used).toContain('vampire.night.biteAria');
    expect(used).toContain('vampire.role.jester.name');
    expect(used).toContain('vampire.end.reason.vampires-parity');
  });

  it('ships every language on disk, English first', () => {
    expect(SHIPPED_LOCALES).toEqual(['en', ...onDisk.filter((code) => code !== 'en')]);
  });

  it('translates its catalogue summary, which the host shows', () => {
    expect(english[CATALOG_SUMMARY_KEY]?.trim()).toBeTruthy();
  });

  it('has English for every key the panel renders', () => {
    expect(used.filter((key) => !english[key]?.trim())).toEqual([]);
  });

  it('ships no key the panel never renders', () => {
    expect(Object.keys(english).filter((key) => !used.includes(key) && key !== CATALOG_SUMMARY_KEY)).toEqual([]);
  });

  it('formats every English message (valid plural syntax, arguments filled)', () => {
    const sample: Record<string, string | number> = {
      alive: 3, count: 2, cause: 'x', needed: 3, living: 5, voted: 2, max: 12, min: 5, name: 'Ada',
      names: 'Ada', players: 6, role: 'Seer', round: 2, team: 'Village', total: 6, when: 'night 1', actor: 'Bram',
    };
    for (const [key, text] of Object.entries(english)) {
      const out = formatMessage(text, sample, 'en');
      expect(out, key).not.toMatch(/[{}]/);
    }
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
