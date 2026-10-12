/**
 * Marketplace plugins' names and descriptions in every viewer's language.
 *
 * A sandbox-v1 bundle may ship `locales/<code>.json` tables, the same shape
 * as an official plugin's (validated by `parseSandboxBundle`, read from the
 * web app's own copy of the installed files). When the loader registers
 * the plugin it hands the tables to the plugin SDK's locale registry under
 * the plugin's id, so `pluginName()` / `pluginSummary()`
 * (plugin-catalog-text.ts) find its `catalog.name` and `catalog.summary`
 * exactly as they find an official plugin's — the lobby, the app lists and
 * the marketplace need no special case. `manifest.json`'s `name` stays the
 * fallback for a language the bundle does not name itself in.
 *
 * The SDK registry is process-wide (it lives on globalThis), so tables
 * registered while instrumentation warms the plugins are seen by every
 * route and page chunk.
 */
import { replacePluginLocale } from '@lobbyforge/plugin-sdk';
import { getPlugin } from './plugin-registry';

/**
 * Register (or replace) a marketplace plugin's translation tables. A new
 * version's tables replace the old ones entirely; a bundle without
 * `locales/` clears them. Returns false — and registers nothing — for the
 * id of a compiled-in plugin: a marketplace bundle can never rename an
 * official plugin or rewrite its panel's strings.
 */
export function registerSandboxPluginLocales(
  pluginId: string,
  tables: Record<string, Record<string, string>> | undefined
): boolean {
  if (getPlugin(pluginId)) return false;
  replacePluginLocale(pluginId, tables ?? {});
  return true;
}
