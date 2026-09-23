import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Missing-translation guard (the same defect Hushle shipped once).
 *
 * `tFor` falls back to the KEY when a string is missing, so an
 * untranslated panel silently renders `dice.roll.button` to every
 * player instead of crashing. Only a test that diffs the keys the
 * panel actually calls against both locale files catches it.
 */

const ROOT = join(__dirname, '..', '..');
const LOCALES = ['en', 'tr'] as const;

function loadMessages(locale: string): Record<string, string> {
  const raw = JSON.parse(readFileSync(join(ROOT, 'locales', `${locale}.json`), 'utf8')) as
    | Record<string, string>
    | { messages: Record<string, string> };
  return 'messages' in raw && typeof raw.messages === 'object'
    ? raw.messages
    : (raw as Record<string, string>);
}

/** Every `t('dice.…')` key the panel renders. */
function usedKeys(): string[] {
  const source = readFileSync(join(ROOT, 'src', 'renderClient.tsx'), 'utf8');
  return [...new Set([...source.matchAll(/\bt\(\s*'(dice\.[^']+)'/g)].map((m) => m[1]!))].sort();
}

describe('dice-bot locales', () => {
  const keys = usedKeys();

  it('finds the keys the panel uses', () => {
    expect(keys.length).toBeGreaterThan(20);
    expect(keys).toContain('dice.roll.button');
    expect(keys).toContain('dice.stats.heading');
    expect(keys).toContain('dice.host.reset');
  });

  it.each(LOCALES)('%s translates every key the panel renders', (locale) => {
    const messages = loadMessages(locale);
    const missing = keys.filter((key) => !messages[key]?.trim());
    expect(missing).toEqual([]);
  });

  it('keeps the locales in sync with each other', () => {
    const [base, ...rest] = LOCALES.map((locale) => Object.keys(loadMessages(locale)).sort());
    for (const other of rest) expect(other).toEqual(base);
  });

  it('ships no key the panel never renders', () => {
    // Keeps the two files honest in the other direction: a key that
    // exists in en.json but nowhere in the panel is dead weight that
    // will drift out of sync with tr.json.
    const messages = loadMessages('en');
    const unused = Object.keys(messages).filter((key) => !keys.includes(key));
    expect(unused).toEqual([]);
  });
});
