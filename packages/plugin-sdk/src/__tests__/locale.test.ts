import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  tFor,
  loadPluginLocale,
  registerPluginLocale,
  replacePluginLocale,
  listPluginLocales,
  detectLocale,
  pickBestLocale,
  __resetPluginLocaleRegistry,
} from '../locale.js';

describe('@lobbyforge/plugin-sdk/locale', () => {
  beforeEach(() => {
    __resetPluginLocaleRegistry();
  });

  it('registers a plugin locale table and resolves a key', () => {
    loadPluginLocale('hushle', {
      en: { 'lobby.title': 'Hushle Lobby', 'lobby.subtitle': 'Pick a pack' },
      tr: { 'lobby.title': 'Hushle Lobisi', 'lobby.subtitle': 'Paket seç' },
    });
    expect(tFor('hushle', 'en', 'lobby.title')).toBe('Hushle Lobby');
    expect(tFor('hushle', 'tr', 'lobby.title')).toBe('Hushle Lobisi');
  });

  it('falls back to the configured fallback locale when the preferred one is missing', () => {
    loadPluginLocale('hushle', { en: { 'lobby.title': 'Hushle Lobby' } });
    expect(tFor('hushle', 'tr', 'lobby.title', undefined, 'en')).toBe('Hushle Lobby');
  });

  it('returns the key itself when neither locale has it', () => {
    loadPluginLocale('hushle', { en: {} });
    expect(tFor('hushle', 'en', 'unknown.key')).toBe('unknown.key');
    expect(tFor('hushle', 'tr', 'unknown.key', undefined, 'en')).toBe('unknown.key');
  });

  it('interpolates {name}-style params', () => {
    loadPluginLocale('hushle', {
      en: { 'score.label': 'Score: {score}' },
      tr: { 'score.label': 'Skor: {score}' },
    });
    expect(tFor('hushle', 'en', 'score.label', { score: 7 })).toBe('Score: 7');
    expect(tFor('hushle', 'tr', 'score.label', { score: 7 })).toBe('Skor: 7');
    // Missing params are left as the literal token — a dev can grep.
    expect(tFor('hushle', 'en', 'score.label', {})).toBe('Score: {score}');
  });

  it('listPluginLocales reports every locale the plugin registered', () => {
    loadPluginLocale('hushle', { en: {}, tr: {} });
    expect(listPluginLocales('hushle').sort()).toEqual(['en', 'tr']);
  });

  it('registerPluginLocale merges loaders in registration order, last wins', () => {
    registerPluginLocale('hushle', 'en', () => ({ 'btn.ok': 'OK' }));
    registerPluginLocale('hushle', 'en', () => ({ 'btn.ok': 'Okay', 'btn.cancel': 'Cancel' }));
    expect(tFor('hushle', 'en', 'btn.ok')).toBe('Okay');
    expect(tFor('hushle', 'en', 'btn.cancel')).toBe('Cancel');
  });

  it('a failing loader is silently skipped — the next loader / fallback handles it', () => {
    registerPluginLocale('hushle', 'en', () => {
      throw new Error('boom');
    });
    registerPluginLocale('hushle', 'en', () => ({ 'btn.ok': 'OK' }));
    expect(tFor('hushle', 'en', 'btn.ok')).toBe('OK');
  });

  it('pickBestLocale matches a region-tagged preference to a base language', () => {
    loadPluginLocale('hushle', { en: {}, tr: {} });
    expect(pickBestLocale('hushle', 'tr-TR')).toBe('tr');
    expect(pickBestLocale('hushle', 'en-US')).toBe('en');
    // Locale the plugin doesn't ship — falls back to en.
    expect(pickBestLocale('hushle', 'fr-FR', 'en')).toBe('en');
  });

  it('pickBestLocale prefers the first registered locale when no fallback matches', () => {
    loadPluginLocale('hushle', { tr: {}, en: {} });
    expect(pickBestLocale('hushle', 'fr', 'ja')).toBe('tr');
  });

  it('detectLocale falls back when document is not available', () => {
    expect(detectLocale('en')).toBe('en');
  });

  it('treats a blank value as untranslated and falls back', () => {
    // A scaffolded language starts with every value blank; those strings
    // must read in the fallback language, never as an empty label.
    loadPluginLocale('hushle', { en: { a: 'Start', b: 'Stop' }, de: { a: 'Starten', b: '' } });
    expect(tFor('hushle', 'de', 'a')).toBe('Starten');
    expect(tFor('hushle', 'de', 'b')).toBe('Stop');
  });

  it('never serves $-prefixed metadata as a string', () => {
    loadPluginLocale('hushle', { en: { a: 'Start' }, de: { $status: 'partial', a: 'Starten' } });
    expect(tFor('hushle', 'de', '$status')).toBe('$status');
    expect(tFor('hushle', 'de', 'a')).toBe('Starten');
  });
});
describe('registration', () => {
  it('ignores a second registration of the same table', () => {
    __resetPluginLocaleRegistry();
    const en = { 'x.a': 'A' };
    loadPluginLocale('twice', { en });
    loadPluginLocale('twice', { en });
    expect(listPluginLocales('twice')).toEqual(['en']);
    expect(tFor('twice', 'en', 'x.a')).toBe('A');
  });

  it('sees tables registered after the first lookup', () => {
    __resetPluginLocaleRegistry();
    loadPluginLocale('late', { en: { 'x.a': 'A' } });
    expect(tFor('late', 'tr', 'x.a')).toBe('A');
    loadPluginLocale('late', { tr: { 'x.a': 'Á' } });
    expect(tFor('late', 'tr', 'x.a')).toBe('Á');
  });
});

describe('replacePluginLocale (the host loading a marketplace bundle)', () => {
  it('drops the keys and languages an older bundle shipped', () => {
    __resetPluginLocaleRegistry();
    replacePluginLocale('market', {
      en: { 'catalog.name': 'Buzzer', 'old.key': 'Old' },
      de: { 'catalog.name': 'Summer' },
    });
    expect(tFor('market', 'de', 'catalog.name')).toBe('Summer');
    replacePluginLocale('market', { en: { 'catalog.name': 'Buzzer 2' }, tr: { 'catalog.name': 'Buzzer' } });
    expect(listPluginLocales('market')).toEqual(['en', 'tr']);
    expect(tFor('market', 'en', 'catalog.name')).toBe('Buzzer 2');
    // German is gone: it falls back to English, not to the old table.
    expect(tFor('market', 'de', 'catalog.name')).toBe('Buzzer 2');
    expect(tFor('market', 'en', 'old.key')).toBe('old.key');
  });

  it('forgets every table with an empty map, and leaves other plugins alone', () => {
    __resetPluginLocaleRegistry();
    loadPluginLocale('official', { en: { 'catalog.name': 'Poll' } });
    replacePluginLocale('market', { en: { 'catalog.name': 'Buzzer' } });
    replacePluginLocale('market', {});
    expect(listPluginLocales('market')).toEqual([]);
    expect(tFor('market', 'en', 'catalog.name')).toBe('catalog.name');
    expect(tFor('official', 'en', 'catalog.name')).toBe('Poll');
  });
});

describe('one registry per process', () => {
  it('a second copy of the module sees what the first registered (bundlers duplicate modules across chunks)', async () => {
    __resetPluginLocaleRegistry();
    replacePluginLocale('shared', { tr: { 'catalog.name': 'Zil' } });
    vi.resetModules();
    const copy = await import('../locale.js');
    expect(copy.tFor).not.toBe(tFor);
    expect(copy.tFor('shared', 'tr', 'catalog.name')).toBe('Zil');
    copy.replacePluginLocale('shared', { tr: { 'catalog.name': 'Buzzer' } });
    expect(tFor('shared', 'tr', 'catalog.name')).toBe('Buzzer');
  });
});
