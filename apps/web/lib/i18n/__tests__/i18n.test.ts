import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator, getMessages, interpolate, messageKeys } from '../messages.js';
import { negotiateLocale, readLocaleCookie, serializeLocaleCookie } from '../locale-cookie.js';
import { APP_LOCALES, DEFAULT_APP_LOCALE } from '../../app-locale.js';

const MESSAGES_DIR = join(__dirname, '..', '..', '..', 'messages');

function namespaceFiles(locale: string): string[] {
  return readdirSync(join(MESSAGES_DIR, locale))
    .filter((f) => f.endsWith('.json'))
    .sort();
}

function loadNamespace(locale: string, file: string): Record<string, string> {
  return JSON.parse(readFileSync(join(MESSAGES_DIR, locale, file), 'utf8')) as Record<string, string>;
}

describe('catalogues stay in step', () => {
  /**
   * The catalogues are split one file per area so two people can
   * translate different screens without touching the same file. The
   * cost of that is drift: nothing stops a key being added to English
   * and forgotten everywhere else, and a missing key is SILENT — it
   * falls back to English, which reads like a translation gap nobody
   * reported. These assertions are what makes it loud.
   */
  it('has the same set of namespace files in every language', () => {
    const base = namespaceFiles(DEFAULT_APP_LOCALE);
    for (const locale of APP_LOCALES) {
      expect(namespaceFiles(locale), `${locale} namespaces`).toEqual(base);
    }
  });

  it.each(namespaceFiles(DEFAULT_APP_LOCALE))('%s defines the same keys in every language', (file) => {
    const base = Object.keys(loadNamespace(DEFAULT_APP_LOCALE, file)).sort();
    for (const locale of APP_LOCALES) {
      if (locale === DEFAULT_APP_LOCALE) continue;
      expect(Object.keys(loadNamespace(locale, file)).sort(), `${locale}/${file}`).toEqual(base);
    }
  });

  it.each(APP_LOCALES)('%s has no empty translations', (locale) => {
    for (const file of namespaceFiles(locale)) {
      for (const [key, value] of Object.entries(loadNamespace(locale, file))) {
        expect(typeof value, `${locale}/${file} ${key}`).toBe('string');
        expect(value.trim(), `${locale}/${file} ${key}`).not.toBe('');
      }
    }
  });

  it('keeps every placeholder a translation uses available in English', () => {
    // A `{name}` that exists only in one language renders literally.
    const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    const english = getMessages(DEFAULT_APP_LOCALE);
    for (const locale of APP_LOCALES) {
      if (locale === DEFAULT_APP_LOCALE) continue;
      for (const [key, value] of Object.entries(getMessages(locale))) {
        if (!(key in english)) continue;
        expect(placeholders(value), `${locale} ${key}`).toEqual(placeholders(english[key]!));
      }
    }
  });
});

describe('createTranslator', () => {
  it('falls back to English rather than showing a raw key', () => {
    // A half-translated screen is readable; one full of dotted keys is not.
    const t = createTranslator('tr');
    const englishOnly = messageKeys()[0]!;
    expect(t(englishOnly)).not.toBe(englishOnly);
  });

  it('returns the key when nothing defines it, so the gap is traceable', () => {
    expect(createTranslator('en')('nope.not.a.key')).toBe('nope.not.a.key');
  });

  it('treats an unknown locale as English', () => {
    const t = createTranslator('klingon');
    expect(t('common.close')).toBe(createTranslator('en')('common.close'));
  });

  it('substitutes placeholders', () => {
    expect(interpolate('Message {name}', { name: 'Ada' })).toBe('Message Ada');
    expect(interpolate('{a} and {b}', { a: '1', b: '2' })).toBe('1 and 2');
  });

  it('leaves a placeholder alone when no value is supplied', () => {
    // Better a visible {name} than the word silently vanishing.
    expect(interpolate('Message {name}', {})).toBe('Message {name}');
    expect(interpolate('Message {name}')).toBe('Message {name}');
  });
});

describe('locale cookie', () => {
  it('reads the locale out of a cookie header', () => {
    expect(readLocaleCookie('lf_locale=tr')).toBe('tr');
    expect(readLocaleCookie('a=1; lf_locale=en; b=2')).toBe('en');
  });

  it('ignores a value it does not support', () => {
    expect(readLocaleCookie('lf_locale=fr')).toBeNull();
    expect(readLocaleCookie('')).toBeNull();
    expect(readLocaleCookie(null)).toBeNull();
  });

  it('round-trips what it serialises', () => {
    expect(readLocaleCookie(serializeLocaleCookie('tr').split(';')[0]!)).toBe('tr');
  });

  it('does not mark the cookie HttpOnly — the client writes it too', () => {
    expect(serializeLocaleCookie('en').toLowerCase()).not.toContain('httponly');
    expect(serializeLocaleCookie('en')).toContain('SameSite=Lax');
  });
});

describe('negotiateLocale', () => {
  it('honours quality values rather than document order', () => {
    // `fr` is listed first but we have no French; Turkish outranks English.
    expect(negotiateLocale('fr;q=0.9, tr;q=0.8, en;q=0.7')).toBe('tr');
  });

  it('takes the first supported language when no weights are given', () => {
    expect(negotiateLocale('tr-TR,tr;q=0.9,en;q=0.8')).toBe('tr');
    expect(negotiateLocale('en-GB,en')).toBe('en');
  });

  it('falls back to English for anything unsupported or missing', () => {
    expect(negotiateLocale('fr,de,ja')).toBe('en');
    expect(negotiateLocale('')).toBe('en');
    expect(negotiateLocale(null)).toBe('en');
  });

  it('survives a malformed header', () => {
    expect(APP_LOCALES).toContain(negotiateLocale(';;;q=,,'));
  });
});
