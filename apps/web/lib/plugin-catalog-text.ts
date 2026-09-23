import { CATALOG_SUMMARY_KEY, tFor } from '@lobbyforge/plugin-sdk';

/**
 * A plugin's catalogue summary in `locale`: the plugin's own translation
 * (`catalog.summary` in its `locales/*.json`) when it ships one, else the
 * manifest's text. The plugin's tables are registered when its module
 * loads — for compiled-in plugins, via `lib/plugin-registry`.
 */
export function pluginSummary(pluginId: string, locale: string, manifestSummary: string | null): string | null {
  const text = tFor(pluginId, locale, CATALOG_SUMMARY_KEY);
  return text === CATALOG_SUMMARY_KEY ? manifestSummary : text;
}
