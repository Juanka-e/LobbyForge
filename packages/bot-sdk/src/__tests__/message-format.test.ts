import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tFor, loadBotLocale } from '../locale.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe('message format', () => {
  it('is the plugin SDK’s, byte for byte', () => {
    // Copied rather than imported so bots do not depend on a React SDK.
    // One format for app, plugins and bots — so the copy must not drift.
    const ours = readFileSync(here('../message-format.ts'), 'utf8');
    const theirs = readFileSync(here('../../../plugin-sdk/src/message-format.ts'), 'utf8');
    expect(ours).toBe(theirs);
  });

  it('formats plurals by the language the string is written in', () => {
    loadBotLocale('counter-bot', {
      en: { 'q.size': '{count, plural, one {# song} other {# songs}}', 'q.empty': 'Queue is empty' },
      ru: { 'q.size': '{count, plural, one {# песня} few {# песни} many {# песен} other {# песни}}', 'q.empty': '' },
    });
    expect(tFor('counter-bot', 'ru', 'q.size', { count: 5 })).toBe('5 песен');
    expect(tFor('counter-bot', 'en', 'q.size', { count: 1 })).toBe('1 song');
    // A blank is "not translated yet" and falls back to English.
    expect(tFor('counter-bot', 'ru', 'q.empty')).toBe('Queue is empty');
  });
});
