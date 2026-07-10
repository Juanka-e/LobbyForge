import { describe, it, expect } from 'vitest';
import { t, Translator, SUPPORTED_LOCALES } from '../index.js';

describe('translator stand-alone t() helper', () => {
  it('should look up translation in user locale', () => {
    // voice.join is "Join voice" in en, "Sese katıl" in tr
    expect(t('voice.join', undefined, 'tr')).toBe('Sese katıl');
    expect(t('voice.join', undefined, 'en')).toBe('Join voice');
  });

  it('should fallback to server default when user locale is missing or unsupported', () => {
    // 'fr' is not supported, should fallback to tr (server default)
    expect(t('voice.join', undefined, 'fr', 'tr')).toBe('Sese katıl');
  });

  it('should fallback to "en" when server default is unsupported', () => {
    // 'fr' user locale, 'de' server default -> should fallback to 'en'
    expect(t('voice.join', undefined, 'fr', 'de')).toBe('Join voice');
  });

  it('should fallback to key itself if not found anywhere', () => {
    expect(t('nonexistent.key', undefined, 'en', 'en')).toBe('nonexistent.key');
  });

  it('should interpolate parameters', () => {
    expect(t('welcome.user', { username: 'Alice' }, 'en')).toBe('Welcome, Alice!');
    expect(t('welcome.user', { username: 'Ahmet' }, 'tr')).toBe('Hoş geldin, Ahmet!');
  });
});

describe('Translator class', () => {
  it('should translate correctly with fallback logic', () => {
    const translator = new Translator('en');
    expect(translator.translate('voice.join')).toBe('Join voice');
    expect(translator.translate('voice.join', 'tr')).toBe('Sese katıl');
  });

  it('should support dynamic registration of new language packs', () => {
    const translator = new Translator('en');
    translator.register('fr', { 'app.greet': 'Bonjour {name}' });
    expect(translator.translate('app.greet', 'fr', { name: 'Pierre' })).toBe('Bonjour Pierre');
  });

  it('should support registering plugin locales with namespace mapping', () => {
    const translator = new Translator('en');
    translator.registerPluginLocales('myplugin', {
      en: {
        'action.play': 'Play Game',
        'myplugin.action.stop': 'Stop Game'
      },
      tr: {
        'action.play': 'Oyunu Oyna',
        'myplugin.action.stop': 'Oyunu Durdur'
      }
    });

    expect(translator.translate('myplugin.action.play', 'en')).toBe('Play Game');
    expect(translator.translate('myplugin.action.stop', 'tr')).toBe('Oyunu Durdur');
  });

  it('should expose supported locales', () => {
    expect(SUPPORTED_LOCALES).toContain('en');
    expect(SUPPORTED_LOCALES).toContain('tr');
  });
});
