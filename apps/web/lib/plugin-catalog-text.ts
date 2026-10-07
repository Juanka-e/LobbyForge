import { CATALOG_SUMMARY_KEY, tFor } from '@lobbyforge/plugin-sdk';

/**
 * The key a plugin's locale files use to translate its display name — the
 * sibling of `catalog.summary` (`CATALOG_SUMMARY_KEY`). "Poll" is "Anket"
 * in Turkish: the activity bar, the gallery card and the sidebar chips
 * must say what the plugin's own panel says.
 */
export const CATALOG_NAME_KEY = 'catalog.name';

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

/**
 * A plugin's name in `locale`: its own `catalog.name` translation when it
 * ships one, else the manifest's name. Product names (Hushle) simply
 * translate to themselves.
 */
export function pluginName(pluginId: string, locale: string, manifestName: string): string {
  const text = tFor(pluginId, locale, CATALOG_NAME_KEY);
  return text === CATALOG_NAME_KEY || !text.trim() ? manifestName : text;
}
