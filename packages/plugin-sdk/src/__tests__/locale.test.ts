import { describe, it, expect, beforeEach } from 'vitest';
import {
  tFor,
  loadPluginLocale,
  registerPluginLocale,
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
});