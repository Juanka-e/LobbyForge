import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * beta-review regression guard.
 *
 * `hushle.lobby.packLabel` was used by the panel but missing from both
 * locale files, so the pack picker rendered the raw key
 * ("hushle.lobby.packLabel") to every player. A missing translation is
 * silent by design — the lookup falls back to the key — so only a test
 * catches it.
 */

const ROOT = join(__dirname, '..', '..');
const LOCALES = ['en', 'tr'] as const;

function loadMessages(locale: string): Record<string, string> {
  const raw = JSON.parse(readFileSync(join(ROOT, 'locales', `${locale}.json`), 'utf8')) as
    | Record<string, string>
    | { messages: Record<string, string> };
  return 'messages' in raw && typeof raw.messages === 'object' ? raw.messages : (raw as Record<string, string>);
}

/** Every `t('hushle.…')` key the panel renders. */
function usedKeys(): string[] {
  const source = readFileSync(join(ROOT, 'src', 'renderClient.tsx'), 'utf8');
  return [...new Set([...source.matchAll(/\bt\(\s*'(hushle\.[^']+)'/g)].map((m) => m[1]!))].sort();
}

describe('hushle locales', () => {
  const keys = usedKeys();

  it('finds the keys the panel uses', () => {
    expect(keys.length).toBeGreaterThan(20);
    expect(keys).toContain('hushle.lobby.packLabel');
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
});
