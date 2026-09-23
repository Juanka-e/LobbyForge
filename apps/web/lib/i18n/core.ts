/**
 * The pure half of the translation layer — safe on the server, in the
 * browser and in tests. Nothing here knows which languages exist: the
 * list is discovered from disk (`catalogue.ts`) and handed in, so adding
 * a language never means editing this file.
 */

export type Messages = Record<string, string>;
export type Params = Record<string, string | number>;

/** The language every string is written in first, and the fallback for gaps. */
export const SOURCE_LOCALE = 'en';

/**
 * A translator also knows which language it is for, because `Intl`
 * formatting (dates, numbers) has to agree with the sentence around it.
 */
export type Translator = ((key: string, params?: Params) => string) & {
  readonly locale: string;
};

export type TextDirection = 'ltr' | 'rtl';

/**
 * `complete` — every string is translated, and the tests hold it to that.
 * `partial` — a translation in progress: it ships, and every gap falls
 * back to English. This is what lets a community translation go live at
 * 40% instead of waiting in a branch until it is perfect.
 */
export type LocaleStatus = 'complete' | 'partial';

export interface LocaleInfo {
  /** BCP-47 code, which is also the folder name: `tr`, `pt-BR`, `zh-Hans`. */
  code: string;
  /** The language's name in itself — what the picker shows: "Türkçe". */
  name: string;
  /** The same name in English, for tooling and for people who can't read the script. */
  englishName: string;
  dir: TextDirection;
  status: LocaleStatus;
}

/** Folder names that can be a locale. Anything else under `messages/` is ignored. */
export const LOCALE_CODE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * Substitute `{name}` placeholders. Values are inserted verbatim: React
 * escapes them on render, and the catalogues are ours, not user input.
 * A placeholder with no value is left visible — better a stray `{name}`
 * than a word silently vanishing from a sentence.
 */
export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match
  );
}

/**
 * Build a translator over an already-resolved message map (English
 * fallback merged in — see `resolveMessages`). An unknown key returns
 * itself: visible in development, and honest in production, since it
 * names exactly which string was never added.
 */
export function createTranslator(locale: string, messages: Messages): Translator {
  const translate = (key: string, params?: Params) => interpolate(messages[key] ?? key, params);
  return Object.assign(translate, { locale });
}

/**
 * Layer a translation over the source catalogue. Empty strings are
 * treated as "not translated yet": that is how a freshly scaffolded
 * language looks, and those keys must show English, not a blank.
 */
export function resolveMessages(source: Messages, translation: Messages): Messages {
  const resolved: Messages = { ...source };
  for (const [key, value] of Object.entries(translation)) {
    if (typeof value === 'string' && value.trim() !== '') resolved[key] = value;
  }
  return resolved;
}

function baseLanguage(tag: string): string {
  return tag.toLowerCase().split(/[-_]/)[0] ?? '';
}

/**
 * The available locale that best serves a requested tag, or null.
 *
 * Exact match first (`pt-BR` → `pt-BR`), then same base language
 * (`pt-PT` → `pt-BR`, `tr-TR` → `tr`): a Portuguese speaker is better
 * served by the other Portuguese than by English.
 */
export function matchLocale(tag: string | null | undefined, available: readonly string[]): string | null {
  if (!tag) return null;
  const wanted = tag.trim().replace('_', '-').toLowerCase();
  if (!wanted) return null;
  const exact = available.find((code) => code.toLowerCase() === wanted);
  if (exact) return exact;
  const base = baseLanguage(wanted);
  return available.find((code) => baseLanguage(code) === base) ?? null;
}

/**
 * Negotiate from an `Accept-Language` header.
 *
 * Honours quality values rather than document order, so
 * `fr;q=0.9, tr;q=0.8` picks Turkish — the highest-ranked language we
 * actually have — where taking the first entry would give English.
 */
export function negotiateLocale(
  acceptLanguage: string | null | undefined,
  available: readonly string[],
  fallback: string = SOURCE_LOCALE
): string {
  if (!acceptLanguage) return fallback;
  const ranked = acceptLanguage
    .split(',')
    .map((entry, index) => {
      const [tag, ...params] = entry.trim().split(';');
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/i.exec(p)).find(Boolean);
      return { tag: tag?.trim() ?? '', quality: q ? Number(q[1]) : 1, index };
    })
    .filter((entry) => entry.tag && entry.tag !== '*' && !Number.isNaN(entry.quality) && entry.quality > 0)
    // Stable: equal weights keep the order the browser sent them in.
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { tag } of ranked) {
    const match = matchLocale(tag, available);
    if (match) return match;
  }
  return fallback;
}

/** The `{placeholders}` a message uses, sorted — for comparing translations. */
export function placeholdersOf(message: string): string[] {
  return (message.match(/\{(\w+)\}/g) ?? []).sort();
}
