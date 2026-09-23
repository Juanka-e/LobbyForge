import { describe, expect, it } from 'vitest';
import {
  APP_LOCALES,
  coerceLocaleChoice,
  narrowToSupported,
  resolveAppLocale,
} from '../app-locale.js';

/**
 * The bundled plugins ship `tr` tables, and before this resolver existed
 * none of them could ever be selected: the layout renders a fixed
 * `lang="en"` and nothing changed it, so `detectLocale()` always
 * answered English. These tests pin the selection rules that make the
 * shipped translations reachable.
 */
describe('resolveAppLocale', () => {
  it('honours an explicit choice over the browser', () => {
    expect(resolveAppLocale('tr', ['en-GB', 'en'])).toBe('tr');
    expect(resolveAppLocale('en', ['tr-TR'])).toBe('en');
  });

  it('follows the browser when set to system', () => {
    expect(resolveAppLocale('system', ['tr-TR', 'en'])).toBe('tr');
    expect(resolveAppLocale('system', ['en-US'])).toBe('en');
  });

  it('walks past languages it has no tables for', () => {
    // A user whose list is fr, tr, en should get Turkish — not English,
    // which is what a naive "first entry or default" would give.
    expect(resolveAppLocale('system', ['fr-FR', 'tr-TR', 'en'])).toBe('tr');
  });

  it('falls back to English when nothing in the list is supported', () => {
    expect(resolveAppLocale('system', ['fr', 'de', 'ja'])).toBe('en');
    expect(resolveAppLocale('system', [])).toBe('en');
  });

  it('only ever returns a language the plugins actually ship', () => {
    for (const languages of [['de'], ['tr'], [], ['zz-ZZ', 'tr']]) {
      expect(APP_LOCALES).toContain(resolveAppLocale('system', languages));
    }
  });
});

describe('narrowToSupported', () => {
  it('drops the region tag', () => {
    expect(narrowToSupported('tr-TR')).toBe('tr');
    expect(narrowToSupported('en_US')).toBe('en');
    expect(narrowToSupported('TR')).toBe('tr');
  });

  it('returns null for an unsupported or missing tag', () => {
    expect(narrowToSupported('fr-FR')).toBeNull();
    expect(narrowToSupported('')).toBeNull();
    expect(narrowToSupported(null)).toBeNull();
  });
});

describe('coerceLocaleChoice', () => {
  it('defaults anything unrecognised to following the browser', () => {
    expect(coerceLocaleChoice(undefined)).toBe('system');
    expect(coerceLocaleChoice('klingon')).toBe('system');
    expect(coerceLocaleChoice(42)).toBe('system');
  });

  it('keeps a valid choice', () => {
    expect(coerceLocaleChoice('tr')).toBe('tr');
    expect(coerceLocaleChoice('system')).toBe('system');
  });
});

describe('the document language is not the plugin language', () => {
  /**
   * Regression guard. Publishing the plugin language on `<html lang>`
   * looked right and shipped: the plugin panels did render in Turkish.
   * But `lang` states the language of the DOCUMENT, and the app's own
   * chrome is English — so CSS `text-transform: uppercase` started
   * applying Turkish casing to English labels and the sidebar read
   * "ACTİVİTİES", "DİRECT MESSAGES", "VOİCE CONNECTED".
   *
   * The host publishes `data-lf-locale` instead and tags only the
   * plugin's own subtree with `lang`. These assertions pin that split;
   * the casing itself is a browser behaviour no unit test can observe.
   */
  it('turns English labels into Turkish casing when lang says tr', () => {
    // Why the attribute matters, demonstrated on the exact strings that
    // regressed. `toLocaleUpperCase` follows the same Unicode rules the
    // CSS transform does.
    expect('Activities'.toLocaleUpperCase('tr')).toBe('ACTİVİTİES');
    expect('Direct Messages'.toLocaleUpperCase('tr')).toBe('DİRECT MESSAGES');
    // ...and is correct under English rules, which is what the chrome needs.
    expect('Activities'.toLocaleUpperCase('en')).toBe('ACTIVITIES');
  });

  it('keeps the host attribute separate from the document language', async () => {
    const { HOST_LOCALE_ATTRIBUTE } = await import('@lobbyforge/plugin-sdk');
    // `dataset.lfLocale` ⇄ the `data-lf-locale` attribute.
    expect(HOST_LOCALE_ATTRIBUTE).toBe('lfLocale');
  });
});
