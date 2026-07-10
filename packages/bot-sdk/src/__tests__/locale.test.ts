import { describe, it, expect, beforeEach } from 'vitest';
import {
  tFor,
  loadBotLocale,
  registerBotLocale,
  listBotLocales,
  pickBestLocale,
  __resetBotLocaleRegistry,
} from '../locale.js';

describe('@lobbyforge/bot-sdk/locale', () => {
  beforeEach(() => {
    __resetBotLocaleRegistry();
  });

  it('registers a bot locale table and resolves a key', () => {
    loadBotLocale('music-bot', {
      en: { 'queue.empty': 'Queue is empty', 'queue.now': 'Now playing: {title}' },
      tr: { 'queue.empty': 'Kuyruk boş', 'queue.now': 'Şimdi çalıyor: {title}' },
    });
    expect(tFor('music-bot', 'en', 'queue.empty')).toBe('Queue is empty');
    expect(tFor('music-bot', 'tr', 'queue.now', { title: 'Song' })).toBe(
      'Şimdi çalıyor: Song'
    );
  });

  it('falls back to the fallback locale when the preferred one is missing', () => {
    loadBotLocale('music-bot', { en: { 'queue.empty': 'Queue is empty' } });
    expect(tFor('music-bot', 'tr', 'queue.empty', undefined, 'en')).toBe('Queue is empty');
  });

  it('listBotLocales reports every locale the bot registered', () => {
    loadBotLocale('music-bot', { en: {}, tr: {}, de: {} });
    expect(listBotLocales('music-bot').sort()).toEqual(['de', 'en', 'tr']);
  });

  it('registerBotLocale merges loaders, last wins', () => {
    registerBotLocale('music-bot', 'en', () => ({ 'btn.play': 'Play' }));
    registerBotLocale('music-bot', 'en', () => ({ 'btn.play': 'Start' }));
    expect(tFor('music-bot', 'en', 'btn.play')).toBe('Start');
  });

  it('pickBestLocale handles region tags', () => {
    loadBotLocale('music-bot', { en: {}, tr: {} });
    expect(pickBestLocale('music-bot', 'tr-TR')).toBe('tr');
    expect(pickBestLocale('music-bot', 'fr-FR', 'en')).toBe('en');
  });

  it('adding a new language is a one-line change', () => {
    // The whole point of this helper: a bot author adds a locale file
    // and one loadBotLocale call. The host doesn't have to learn any
    // new config.
    loadBotLocale('music-bot', { en: { 'queue.empty': 'Queue is empty' } });
    loadBotLocale('music-bot', { es: { 'queue.empty': 'La cola está vacía' } });
    expect(listBotLocales('music-bot').sort()).toEqual(['en', 'es']);
    expect(tFor('music-bot', 'es', 'queue.empty')).toBe('La cola está vacía');
  });
});