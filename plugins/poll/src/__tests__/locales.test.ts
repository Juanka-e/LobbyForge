import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard, copied from Hushle.
 *
 * A missing translation is SILENT by design — `tFor` falls back to the
 * key itself, so a typo ships as a player-visible
 * "poll.compose.openButton" button label. Only a test catches it, and
 * only a test keeps `en` and `tr` from drifting apart.
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

/** Every `t('poll.…')` key the panel renders. */
function usedKeys(): string[] {
  const source = readFileSync(join(ROOT, 'src', 'renderClient.tsx'), 'utf8');
  return [...new Set([...source.matchAll(/\bt\(\s*'(poll\.[^']+)'/g)].map((m) => m[1]!))].sort();
}

describe('poll locales', () => {
  const keys = usedKeys();

  it('finds the keys the panel uses', () => {
    expect(keys.length).toBeGreaterThan(20);
    expect(keys).toContain('poll.compose.openButton');
    expect(keys).toContain('poll.open.voteFor');
    expect(keys).toContain('poll.closed.reopenButton');
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
    // Keeps the tables honest in the other direction: a key nobody
    // renders is a translation cost with no payoff.
    const orphans = Object.keys(loadMessages('en')).filter((key) => !keys.includes(key));
    expect(orphans).toEqual([]);
  });
});
