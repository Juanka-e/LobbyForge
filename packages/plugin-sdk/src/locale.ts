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

import { formatMessage } from './message-format.js';

export { formatMessage, messageArguments, PLURAL_CATEGORIES, type MessageParams } from './message-format.js';

export type LocaleId = string;

/**
 * The key a plugin's locale files use to translate its catalogue summary
 * (the one-line description the host shows in activity pickers and admin
 * lists). The host prefers it over `catalog.summary` in the manifest, so
 * a plugin's description is translated the same way as its buttons.
 */
export const CATALOG_SUMMARY_KEY = 'catalog.summary';

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
  // Tables are materialized lazily and cached; a registration after the
  // first lookup must be seen, not silently ignored.
  localeTables.delete(pluginId);
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
    // Idempotent per table: a plugin registers from its entry module
    // (evaluated on the server) AND its client panel (a 'use client'
    // module the server never runs), so the browser sees both calls.
    const seen = loadedTables.get(table) ?? new Set<string>();
    const slot = `${pluginId}\u0000${locale}`;
    if (seen.has(slot)) continue;
    seen.add(slot);
    loadedTables.set(table, seen);
    registerPluginLocale(pluginId, locale, () => table);
  }
}

let loadedTables = new WeakMap<LocaleTable, Set<string>>();

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
            for (const [key, value] of Object.entries(t)) {
              // `$`-prefixed entries are file metadata (`$status`), not
              // strings anyone should ever be shown.
              if (key.startsWith('$')) continue;
              merged[key] = value;
            }
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
 * `params` fills the message's arguments — `{score}`, and plurals such as
 * `{count, plural, one {# point} other {# points}}`. See `message-format.ts`.
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
    const value = tables.get(loc)?.[key];
    // A blank value is a string nobody has translated yet — that is what
    // `pnpm i18n:add` scaffolds — so it falls through to the fallback
    // language instead of rendering an empty label.
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  const own = tryLookup(locale);
  const template = own ?? tryLookup(fallbackLocale) ?? key;
  // Plural rules follow the language the string is actually written in:
  // a gap that fell back to English is English.
  return formatMessage(template, params, own !== undefined && locale ? locale : fallbackLocale);
}

/**
 * The attribute the host uses to publish the PLUGIN language.
 *
 * Separate from `<html lang>`, which states the language of the page.
 * The two usually agree, but a plugin may not ship the user's language:
 * then the page is (say) Turkish while the panel falls back to English,
 * and the host tags the panel itself with `lang` so CSS casing and screen
 * readers are right there.
 */
export const HOST_LOCALE_ATTRIBUTE = 'lfLocale';

/**
 * Detect the active plugin locale. Reads the host's
 * `data-lf-locale` attribute, falling back to `<html lang>` for hosts
 * that do not set it. Returns `fallback` when there is no document
 * (server render) or no language.
 */
export function detectLocale(fallback: LocaleId = 'en'): LocaleId {
  if (typeof document === 'undefined') return fallback;
  const root = document.documentElement;
  const published = root.dataset?.[HOST_LOCALE_ATTRIBUTE]?.toLowerCase() ?? '';
  const lang = published || (root.lang?.toLowerCase() ?? '');
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
  loadedTables = new WeakMap();
}