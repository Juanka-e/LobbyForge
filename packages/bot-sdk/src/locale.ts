/**
 * Shared locale helper for bot authors.
 *
 * Mirrors `@lobbyforge/plugin-sdk/locale` exactly, but the registry
 * is keyed by `botId` instead of `pluginId`. Keeping two parallel
 * registries instead of one shared map is intentional:
 *
 *   - The plugin SDK has `react` as a peer dep; the bot SDK does
 *     not. They can live in separate workspaces cleanly.
 *   - Some hosts may run plugins but not bots, or vice versa.
 *     Splitting the registry keeps each SDK's API surface small.
 *
 * The shape of the API is identical so the muscle memory transfers.
 * Bot authors do:
 *
 *     import en from './locales/en.json';
 *     import tr from './locales/tr.json';
 *     loadBotLocale('music-bot', { en, tr });
 *
 *     // Inside a handler:
 *     tFor('music-bot', ctx.locale, 'queue.empty')
 *
 * Adding a new language to the music-bot is a single import +
 * `loadBotLocale` call. Community bots do the same.
 */

export type LocaleId = string;

export type LocaleTable = Record<string, string>;

export type BotLocaleLoader = () => LocaleTable;

const localeTables = new Map<string, Map<LocaleId, LocaleTable>>();
const localeLoaders = new Map<string, Map<LocaleId, BotLocaleLoader[]>>();

export function registerBotLocale(
  botId: string,
  locale: LocaleId,
  loader: BotLocaleLoader
): void {
  let perLocale = localeLoaders.get(botId);
  if (!perLocale) {
    perLocale = new Map();
    localeLoaders.set(botId, perLocale);
  }
  let arr = perLocale.get(locale);
  if (!arr) {
    arr = [];
    perLocale.set(locale, arr);
  }
  arr.push(loader);
}

export function loadBotLocale(
  botId: string,
  tables: Partial<Record<LocaleId, LocaleTable>>
): void {
  for (const [locale, table] of Object.entries(tables)) {
    if (!table) continue;
    registerBotLocale(botId, locale, () => table);
  }
}

function materializeLocaleTables(botId: string): Map<LocaleId, LocaleTable> {
  const cached = localeTables.get(botId);
  if (cached) return cached;
  const next = new Map<LocaleId, LocaleTable>();
  const loaders = localeLoaders.get(botId);
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
          // skip a failing loader; the next loader / fallback handles it
        }
      }
      next.set(locale, merged);
    }
  }
  localeTables.set(botId, next);
  return next;
}

export function listBotLocales(botId: string): LocaleId[] {
  const loaders = localeLoaders.get(botId);
  if (loaders) return Array.from(loaders.keys());
  const tables = materializeLocaleTables(botId);
  return Array.from(tables.keys());
}

export function tFor(
  botId: string,
  locale: LocaleId | null | undefined,
  key: string,
  params?: Record<string, string | number>,
  fallbackLocale: LocaleId = 'en'
): string {
  const tables = materializeLocaleTables(botId);
  const tryLookup = (loc: LocaleId | null | undefined): string | undefined => {
    if (!loc) return undefined;
    const table = tables.get(loc);
    return table ? table[key] : undefined;
  };
  const template = tryLookup(locale) ?? tryLookup(fallbackLocale) ?? key;
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    const v = params[name];
    return v === undefined ? match : String(v);
  });
}

export function detectLocale(fallback: LocaleId = 'en'): LocaleId {
  if (typeof document === 'undefined') return fallback;
  const lang = document.documentElement.lang?.toLowerCase() ?? '';
  if (!lang) return fallback;
  const trimmed = lang.split(/[-_]/)[0] ?? '';
  return trimmed || fallback;
}

export function pickBestLocale(
  botId: string,
  preferred: LocaleId | null | undefined,
  fallbackLocale: LocaleId = 'en'
): LocaleId {
  const available = listBotLocales(botId);
  if (available.length === 0) return fallbackLocale;
  if (preferred && available.includes(preferred)) return preferred;
  if (preferred) {
    const trimmed = preferred.split(/[-_]/)[0] ?? '';
    const exact = available.find((l) => l === trimmed);
    if (exact) return exact;
  }
  return available.includes(fallbackLocale) ? fallbackLocale : available[0]!;
}

export function __resetBotLocaleRegistry(): void {
  localeTables.clear();
  localeLoaders.clear();
}