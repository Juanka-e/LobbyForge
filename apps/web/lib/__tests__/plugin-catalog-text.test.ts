import { describe, expect, it } from 'vitest';
import { listPluginSummaries } from '../plugin-registry';
import { pluginSummary } from '../plugin-catalog-text';

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
