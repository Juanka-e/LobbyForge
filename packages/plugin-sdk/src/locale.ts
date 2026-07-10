/**
 * Shared locale helper for plugin authors.
 *
 * The goal of this module is to make adding a new language to *any*
 * plugin (and bot) a one-place change. The pattern is:
 *
 *   1. Plugin author ships `locales/{lang}.json` bundles for every
 *      language the plugin supports.
 *   2. At module load, the plugin calls `registerPluginLocale(id,
 *      loader)` for each language it ships. The loader returns the
 *      JSON table.
 *   3. The plugin's renderClient calls `tFor(id, key, params)` to
 *      resolve a string for the user's active language.
 *   4. The first time the host's locale registry is queried for a
 *      plugin id, the loaders are run and cached.
 *
 * Community plugins ship their own loaders the same way — no SDK
 * change is required. The host doesn't have to know what languages
 * exist in advance; it learns from the plugin's loaders.
 *
 * Why a per-plugin registry and not a single shared JSON bundle?
 * The plugin is the source of truth for what strings it needs. A
 * shared bundle would force every language addition to touch every
 * plugin; with the per-plugin registry, adding a new language to one
 * plugin is a single `registerPluginLocale` call.
 *
 * The downside is that a community plugin author has to register
 * loaders manually. The `loadPluginLocale` helper below accepts the
 * loader maps as a single object, so the boilerplate is one line:
 *
 *     import en from './locales/en.json';
 *     import tr from './locales/tr.json';
 *     loadPluginLocale('hushle', { en, tr });
 *
 * From then on `tFor('hushle', 'lobby.title')` works with no further
 * wiring.
 */

export type LocaleId = string;

/** Minimal shape of a locale table — flat key→string map. */
export type LocaleTable = Record<string, string>;

/** Loader for a single (pluginId, locale) pair. Async to allow JSON
 *  imports that the bundler hasn't materialized yet, but most plugins
 *  use a sync `() => en` style loader. */
export type PluginLocaleLoader = () => LocaleTable;

/**
 * Internal registry: pluginId → (locale → table).
 *
 * Keyed on `pluginId` first because the locale cache is per-plugin.
 * The first call to `tFor(pluginId, ...)` for a given pluginId
 * materializes the plugin's tables by running every registered
 * loader. After that the cache is hot.
 */
const localeTables = new Map<string, Map<LocaleId, LocaleTable>>();
const localeLoaders = new Map<string, Map<LocaleId, PluginLocaleLoader[]>>();

/**
 * Register a loader for a (pluginId, locale) pair. Multiple loaders
 * for the same pair are merged in registration order — keys from
 * later loaders win on conflict. This lets a community plugin ship
 * a base set of strings and let the host patch them at boot time
 * (e.g. inject instance branding).
 */
export function registerPluginLocale(
  pluginId: string,
  locale: LocaleId,
  loader: PluginLocaleLoader
): void {
  let perLocale = localeLoaders.get(pluginId);
  if (!perLocale) {
    perLocale = new Map();
    localeLoaders.set(pluginId, perLocale);
  }
  let arr = perLocale.get(locale);
  if (!arr) {
    arr = [];
    perLocale.set(locale, arr);
  }
  arr.push(loader);
}

/**
 * Convenience: register a whole table map at once. Equivalent to
 * calling `registerPluginLocale` for every key in `tables`.
 *
 *     loadPluginLocale('hushle', { en, tr });
 *
 * The recommended invocation pattern — keep it next to the JSON
 * imports at the top of the plugin's main entry.
 */
export function loadPluginLocale(
  pluginId: string,
  tables: Partial<Record<LocaleId, LocaleTable>>
): void {
  for (const [locale, table] of Object.entries(tables)) {
    if (!table) continue;
    registerPluginLocale(pluginId, locale, () => table);
  }
}

function materializeLocaleTables(pluginId: string): Map<LocaleId, LocaleTable> {
  const cached = localeTables.get(pluginId);
  if (cached) return cached;
  const next = new Map<LocaleId, LocaleTable>();
  const loaders = localeLoaders.get(pluginId);
  if (loaders) {
    for (const [locale, fns] of loaders.entries()) {
      const merged: LocaleTable = {};
      for (const fn of fns) {
        try {
          const t = fn();
          if (t && typeof t === 'object') {
            Object.assign(merged, t);
          }
        } catch {
          // A failing loader shouldn't break the whole plugin — skip
          // and let the next loader / fallback handle the missing
          // keys.
        }
      }
      next.set(locale, merged);
    }
  }
  localeTables.set(pluginId, next);
  return next;
}

/**
 * The list of locales a plugin has registered, in registration
 * order. The first entry is the "primary" locale — `pickBestLocale`
 * returns it when neither the user's preference nor the configured
 * fallback is available. The room page can also use this list to
 * render the host UI's language switcher.
 *
 * Insertion order (not alphabetical) is intentional: a plugin
 * author picks their primary locale and adds more later. The order
 * they ship the `loadPluginLocale({...})` map in is the order we
 * surface here.
 */
export function listPluginLocales(pluginId: string): LocaleId[] {
  const loaders = localeLoaders.get(pluginId);
  if (loaders) return Array.from(loaders.keys());
  const tables = materializeLocaleTables(pluginId);
  return Array.from(tables.keys());
}

/**
 * Resolve a string for a plugin. `key` is dot- or slash-free; the
 * JSON tables in the plugins are flat. Falls back to the table for
 * `fallbackLocale` (defaults to 'en') and finally to `key` itself so
 * a missing translation surfaces as something the developer can grep.
 *
 * `params` is an optional `{name}` interpolation map. The tokens are
 * `{name}` style — `{score}`, `{seconds}`, etc.
 */
export function tFor(
  pluginId: string,
  locale: LocaleId | null | undefined,
  key: string,
  params?: Record<string, string | number>,
  fallbackLocale: LocaleId = 'en'
): string {
  const tables = materializeLocaleTables(pluginId);
  const tryLookup = (loc: LocaleId | null | undefined): string | undefined => {
    if (!loc) return undefined;
    const table = tables.get(loc);
    return table ? table[key] : undefined;
  };
  const template =
    tryLookup(locale) ?? tryLookup(fallbackLocale) ?? key;
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    const v = params[name];
    return v === undefined ? match : String(v);
  });
}

/**
 * Detect the active locale from the browser. Reads the host's
 * `<html lang>` attribute (which the host sets from the user
 * preference at SSR time). Returns `null` if document is not
 * available (server render) or the language is missing.
 */
export function detectLocale(fallback: LocaleId = 'en'): LocaleId {
  if (typeof document === 'undefined') return fallback;
  const lang = document.documentElement.lang?.toLowerCase() ?? '';
  if (!lang) return fallback;
  // Trim region tags: `tr-TR` → `tr`.
  const trimmed = lang.split(/[-_]/)[0] ?? '';
  return trimmed || fallback;
}

/**
 * Pick the best match between the user's preferred locale and the
 * locales the plugin has actually registered. Falls back to the
 * first registered locale, then to `fallbackLocale`.
 *
 * Use this in `renderClient` to defend against the case where the
 * browser is set to `fr` but the plugin only ships `en` + `tr` —
 * the panel should show `en` (or `tr` if the user picked it).
 */
export function pickBestLocale(
  pluginId: string,
  preferred: LocaleId | null | undefined,
  fallbackLocale: LocaleId = 'en'
): LocaleId {
  const available = listPluginLocales(pluginId);
  if (available.length === 0) return fallbackLocale;
  if (preferred && available.includes(preferred)) return preferred;
  // Try a language-only match: `tr-TR` should still match `tr`.
  if (preferred) {
    const trimmed = preferred.split(/[-_]/)[0] ?? '';
    const exact = available.find((l) => l === trimmed);
    if (exact) return exact;
  }
  return available.includes(fallbackLocale) ? fallbackLocale : available[0]!;
}

/**
 * Reset the internal caches. Tests use this to isolate per-test
 * plugin registrations. Production code should not call it.
 */
export function __resetPluginLocaleRegistry(): void {
  localeTables.clear();
  localeLoaders.clear();
}