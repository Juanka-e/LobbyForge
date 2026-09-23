import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HOST_LOCALE_ATTRIBUTE } from '@lobbyforge/plugin-sdk';
import {
  LOCALE_META_FILE,
  discoverLocales,
  loadMessages,
  parseLocaleMeta,
  readCatalogue,
  translatorFor,
} from '../catalogue.js';
import {
  SOURCE_LOCALE,
  createTranslator,
  interpolate,
  matchLocale,
  negotiateLocale,
  placeholdersOf,
  resolveMessages,
} from '../core.js';
import { clearLocaleCookie, readLocaleCookie, serializeLocaleCookie } from '../locale-cookie.js';

/**
 * The contract that makes adding a language safe.
 *
 * Languages are discovered from `messages/`, not listed in code, so these
 * tests cannot name the languages either — they run the same checks over
 * whatever is on disk. A new language is held to them the moment its
 * folder exists, with nobody editing this file.
 */

// ---------------------------------------------------------------------------
// The catalogues that ship
// ---------------------------------------------------------------------------

const { locales, problems } = discoverLocales();
const source = readCatalogue(SOURCE_LOCALE);
/** Which file each English key lives in. */
const sourceFileOf = new Map<string, string>();
for (const [file, table] of Object.entries(source.files)) {
  for (const key of Object.keys(table)) sourceFileOf.set(key, file);
}

describe('the shipped catalogues', () => {
  it('has no broken locale folders', () => {
    expect(problems).toEqual([]);
  });

  it('ships the source language, complete, and lists it first', () => {
    expect(locales[0]?.code).toBe(SOURCE_LOCALE);
    expect(locales[0]?.status).toBe('complete');
  });

  it('has no empty English strings — English is what every gap falls back to', () => {
    const empty = Object.entries(source.messages)
      .filter(([, value]) => value.trim() === '')
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });

  it('defines each English key in exactly one file', () => {
    expect(source.duplicates).toEqual([]);
  });

  describe.each(locales.filter((l) => l.code !== SOURCE_LOCALE))('$code ($englishName, $status)', (info) => {
    const catalogue = readCatalogue(info.code);

    it('defines no key that English does not have', () => {
      // An orphan is a key renamed or deleted in English and left behind
      // here — it can never be shown, and it hides the real key's gap.
      const orphans = Object.keys(catalogue.messages).filter((key) => !(key in source.messages));
      expect(orphans).toEqual([]);
    });

    it('keeps each key in the same file as English, so the two read side by side', () => {
      const misplaced: string[] = [];
      for (const [file, table] of Object.entries(catalogue.files)) {
        for (const key of Object.keys(table)) {
          const expected = sourceFileOf.get(key);
          if (expected && expected !== file) misplaced.push(`${key}: ${file}, expected ${expected}`);
        }
      }
      expect(misplaced).toEqual([]);
    });

    it('defines each key in only one file', () => {
      expect(catalogue.duplicates).toEqual([]);
    });

    it('uses exactly the placeholders English uses', () => {
      // A `{name}` only one language has renders literally in the other.
      const mismatched = Object.entries(catalogue.messages)
        .filter(([key, value]) => value.trim() !== '' && key in source.messages)
        .filter(([key, value]) => placeholdersOf(value).join() !== placeholdersOf(source.messages[key]!).join())
        .map(([key]) => key);
      expect(mismatched).toEqual([]);
    });

    if (info.status === 'complete') {
      it('translates every string, because it is marked complete', () => {
        const missing = Object.keys(source.messages).filter((key) => !catalogue.messages[key]?.trim());
        expect(missing).toEqual([]);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Adding a language is adding a folder
// ---------------------------------------------------------------------------

describe('adding a language', () => {
  const root = mkdtempSync(join(tmpdir(), 'lf-i18n-'));
  const write = (path: string, value: unknown) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
  };
  write(`en/${LOCALE_META_FILE}`, { name: 'English', englishName: 'English', status: 'complete' });
  write('en/area.json', { 'x.hello': 'Hello {name}', 'x.bye': 'Goodbye' });
  // A community translation, half done: one string translated, one left blank.
  write(`xx/${LOCALE_META_FILE}`, { name: 'Xish', englishName: 'Example', dir: 'rtl', status: 'partial' });
  write('xx/area.json', { 'x.hello': 'Hallo {name}', 'x.bye': '' });
  // Things that must be reported, not crash the instance.
  write('yy/area.json', {});
  write(`Bad_Code/${LOCALE_META_FILE}`, { name: 'Bad', englishName: 'Bad', status: 'partial' });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('discovers the new folder with no code change', () => {
    const found = discoverLocales(root).locales.map((l) => l.code);
    expect(found).toEqual(['en', 'xx']);
  });

  it('reads the direction and status from the folder itself', () => {
    const xx = discoverLocales(root).locales.find((l) => l.code === 'xx');
    expect(xx).toMatchObject({ name: 'Xish', englishName: 'Example', dir: 'rtl', status: 'partial' });
  });

  it('ships a half-finished translation, falling back to English for every gap', () => {
    const t = translatorFor('xx', root);
    expect(t('x.hello', { name: 'Ada' })).toBe('Hallo Ada');
    expect(t('x.bye')).toBe('Goodbye'); // blank → English, never an empty label
    expect(t.locale).toBe('xx');
  });

  it('reports broken folders instead of taking the site down', () => {
    const { problems: found } = discoverLocales(root);
    expect(found.some((p) => p.includes('yy/') && p.includes(LOCALE_META_FILE))).toBe(true);
    expect(found.some((p) => p.includes('Bad_Code'))).toBe(true);
  });

  it('serves English for a language that does not exist', () => {
    expect(loadMessages('zz', root)['x.bye']).toBe('Goodbye');
    expect(translatorFor('zz', root).locale).toBe('en');
  });

  it('never turns a language code into an arbitrary path', () => {
    // The code usually comes from a cookie; it must not reach the disk
    // unless it is one of the discovered folders.
    expect(() => readCatalogue('../../etc', root)).toThrow();
    expect(loadMessages('../en', root)['x.bye']).toBe('Goodbye');
  });

  it('rejects a malformed _locale.json with a reason', () => {
    expect(parseLocaleMeta('xx', { name: 'X' })).toMatch(/englishName/);
    expect(parseLocaleMeta('xx', { name: 'X', englishName: 'X', status: 'done' })).toMatch(/status/);
    expect(parseLocaleMeta('xx', { name: 'X', englishName: 'X', status: 'partial', dir: 'up' })).toMatch(/dir/);
  });
});

// ---------------------------------------------------------------------------
// Translating
// ---------------------------------------------------------------------------

describe('resolveMessages', () => {
  it('treats blank and whitespace-only strings as not yet translated', () => {
    const resolved = resolveMessages({ a: 'A', b: 'B', c: 'C' }, { a: 'Á', b: '', c: '   ' });
    expect(resolved).toEqual({ a: 'Á', b: 'B', c: 'C' });
  });
});

describe('createTranslator', () => {
  it('returns the key when nothing defines it, so the gap is traceable', () => {
    expect(createTranslator('en', {})('nope.not.a.key')).toBe('nope.not.a.key');
  });

  it('carries its locale for Intl formatting', () => {
    expect(createTranslator('tr', {}).locale).toBe('tr');
  });

  it('substitutes placeholders, and leaves a missing one visible', () => {
    expect(interpolate('Message {name}', { name: 'Ada' })).toBe('Message Ada');
    expect(interpolate('{a} and {b}', { a: '1', b: '2' })).toBe('1 and 2');
    expect(interpolate('Message {name}', {})).toBe('Message {name}');
  });

  it('translates the shipped catalogues end to end', () => {
    expect(translatorFor('en')('common.close')).toBe('Close');
    expect(translatorFor('tr')('common.close')).not.toBe('Close');
  });
});

// ---------------------------------------------------------------------------
// Choosing a language
// ---------------------------------------------------------------------------

describe('matchLocale', () => {
  const available = ['en', 'tr', 'pt-BR'];

  it('prefers an exact match, ignoring case and separator', () => {
    expect(matchLocale('pt-br', available)).toBe('pt-BR');
    expect(matchLocale('pt_BR', available)).toBe('pt-BR');
  });

  it('falls back to the same language in another region', () => {
    // A Portuguese speaker is better served by the other Portuguese.
    expect(matchLocale('pt-PT', available)).toBe('pt-BR');
    expect(matchLocale('tr-TR', available)).toBe('tr');
  });

  it('returns null when nothing fits', () => {
    expect(matchLocale('fr', available)).toBeNull();
    expect(matchLocale('', available)).toBeNull();
    expect(matchLocale(null, available)).toBeNull();
  });
});

describe('negotiateLocale', () => {
  const available = ['en', 'tr'];

  it('honours quality values rather than document order', () => {
    expect(negotiateLocale('fr;q=0.9, tr;q=0.8, en;q=0.7', available)).toBe('tr');
  });

  it('keeps the browser order when weights are equal', () => {
    expect(negotiateLocale('tr,en', available)).toBe('tr');
    expect(negotiateLocale('en,tr', available)).toBe('en');
  });

  it('ignores the wildcard and anything weighted zero', () => {
    expect(negotiateLocale('tr;q=0, en', available)).toBe('en');
    expect(negotiateLocale('*', available)).toBe('en');
  });

  it('falls back to English for anything unsupported, missing or malformed', () => {
    expect(negotiateLocale('fr,de,ja', available)).toBe('en');
    expect(negotiateLocale('', available)).toBe('en');
    expect(negotiateLocale(null, available)).toBe('en');
    expect(available).toContain(negotiateLocale(';;;q=,,', available));
  });
});

describe('locale cookie', () => {
  const available = ['en', 'tr'];

  it('reads a saved choice that still exists', () => {
    expect(readLocaleCookie('lf_locale=tr', available)).toBe('tr');
    expect(readLocaleCookie('a=1; lf_locale=en; b=2', available)).toBe('en');
  });

  it('ignores a language the instance no longer offers', () => {
    expect(readLocaleCookie('lf_locale=de', available)).toBeNull();
  });

  it('ignores anything that is not a locale code', () => {
    expect(readLocaleCookie('lf_locale=..%2F..%2Fetc', available)).toBeNull();
    expect(readLocaleCookie('lf_locale=%E0%A4%A', available)).toBeNull();
    expect(readLocaleCookie('', available)).toBeNull();
  });

  it('round-trips what it writes, region tags included', () => {
    const [pair] = serializeLocaleCookie('pt-BR').split(';');
    expect(readLocaleCookie(pair, ['en', 'pt-BR'])).toBe('pt-BR');
  });

  it('is readable by the client that writes it', () => {
    expect(serializeLocaleCookie('en').toLowerCase()).not.toContain('httponly');
    expect(serializeLocaleCookie('en')).toContain('SameSite=Lax');
    expect(clearLocaleCookie()).toContain('Max-Age=0');
  });
});

// ---------------------------------------------------------------------------
// Regression: the document language must match the text on the page
// ---------------------------------------------------------------------------

describe('the document language', () => {
  /**
   * Publishing the PLUGIN language on `<html lang>` while the chrome was
   * still English made CSS `text-transform: uppercase` apply Turkish
   * casing to English labels: the sidebar read "ACTİVİTİES". `lang` has to
   * describe the text actually on the page — now that the chrome is
   * translated it does, and plugins get their own attribute so a plugin
   * that lacks the page's language can still be tagged correctly.
   */
  it('changes casing, which is why it must describe the text on the page', () => {
    expect('Activities'.toLocaleUpperCase('tr')).toBe('ACTİVİTİES');
    expect('Activities'.toLocaleUpperCase('en')).toBe('ACTIVITIES');
  });

  it('publishes the plugin language on its own attribute', () => {
    expect(HOST_LOCALE_ATTRIBUTE).toBe('lfLocale');
  });
});

describe('the instance default language', () => {
  it('is used only when the browser asks for nothing the instance offers', () => {
    // A Turkish community with LOBBYFORGE_DEFAULT_LOCALE=tr: a French
    // browser gets Turkish, but an English browser still gets English.
    expect(negotiateLocale('fr', ['en', 'tr'], 'tr')).toBe('tr');
    expect(negotiateLocale('en', ['en', 'tr'], 'tr')).toBe('en');
    expect(negotiateLocale(null, ['en', 'tr'], 'tr')).toBe('tr');
  });
});
