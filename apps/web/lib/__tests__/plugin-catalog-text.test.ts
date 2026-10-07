import { describe, expect, it } from 'vitest';
import { loadPluginLocale } from '@lobbyforge/plugin-sdk';
import { listPluginSummaries } from '../plugin-registry';
import { pluginName, pluginSummary } from '../plugin-catalog-text';

// Importing the registry loads the compiled-in plugins, which register
// their locale tables — the same path the lobby page takes.
const hushle = listPluginSummaries().find((p) => p.id === 'hushle')!;

describe('pluginSummary', () => {
  it('shows a plugin’s description in the viewer’s language', () => {
    expect(pluginSummary('hushle', 'tr', hushle.catalog?.summary ?? null)).toMatch(/kelime/);
  });

  it('falls back to English for a language the plugin does not ship', () => {
    expect(pluginSummary('hushle', 'de', hushle.catalog?.summary ?? null)).toBe(hushle.catalog?.summary);
  });

  it('keeps the manifest text for a plugin with no translations', () => {
    expect(pluginSummary('not-a-plugin', 'tr', 'From the manifest')).toBe('From the manifest');
    expect(pluginSummary('not-a-plugin', 'tr', null)).toBeNull();
  });
});

describe('pluginName', () => {
  loadPluginLocale('test-name-plugin', {
    en: { 'catalog.name': 'Poll' },
    tr: { 'catalog.name': 'Anket' },
  });

  it('shows the plugin’s own name in the viewer’s language', () => {
    expect(pluginName('test-name-plugin', 'tr', 'Poll')).toBe('Anket');
    expect(pluginName('test-name-plugin', 'en', 'Poll')).toBe('Poll');
  });

  it('falls back to the plugin’s English name for a language it does not ship', () => {
    expect(pluginName('test-name-plugin', 'de', 'Manifest Poll')).toBe('Poll');
  });

  it('keeps the manifest name when the plugin ships no name', () => {
    expect(pluginName('not-a-plugin', 'tr', 'Dice Bot')).toBe('Dice Bot');
  });

  it('names the official Poll "Anket" in Turkish, as its own panel does', () => {
    const poll = listPluginSummaries().find((p) => p.id === 'poll')!;
    expect(pluginName('poll', 'tr', poll.name)).toBe('Anket');
    expect(pluginName('poll', 'en', poll.name)).toBe('Poll');
  });
});
