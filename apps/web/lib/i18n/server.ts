import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { getDiscovery, loadMessages } from './catalogue';
import {
  SOURCE_LOCALE,
  createTranslator,
  negotiateLocale,
  type LocaleInfo,
  type Messages,
  type Translator,
} from './core';
import { readLocaleCookie } from './locale-cookie';

/**
 * Everything the current request needs to know about language, for
 * server components. Wrapped in React's `cache`, so the layout, the page
 * and every nested server component share one resolution per request
 * instead of re-reading cookies and catalogues each time.
 */
export interface RequestI18n {
  locale: string;
  info: LocaleInfo;
  /** What the user chose: a code, or "system" when following the browser. */
  choice: string;
  /** Resolved messages for `locale`, English filling every gap. */
  messages: Messages;
  /** Every language this instance offers, for the picker. */
  locales: LocaleInfo[];
}

const FALLBACK_INFO: LocaleInfo = {
  code: SOURCE_LOCALE,
  name: 'English',
  englishName: 'English',
  dir: 'ltr',
  status: 'complete',
};

/**
 * The language an instance falls back to when a visitor's browser asks
 * for nothing it offers — `LOBBYFORGE_DEFAULT_LOCALE`, e.g. `tr` for a
 * Turkish community whose members' browsers are set to English but who
 * want the community in Turkish. It is only a fallback: a visitor whose
 * browser asks for a language the instance has still gets that one, and
 * an explicit choice always wins. Unset or unknown → English.
 */
export function instanceDefaultLocale(codes: readonly string[]): string {
  const configured = process.env.LOBBYFORGE_DEFAULT_LOCALE?.trim();
  if (!configured) return SOURCE_LOCALE;
  const match = codes.find((code) => code.toLowerCase() === configured.toLowerCase());
  if (!match) {
    console.warn(`[i18n] LOBBYFORGE_DEFAULT_LOCALE="${configured}" is not an installed language; using English`);
    return SOURCE_LOCALE;
  }
  return match;
}

export const getRequestI18n = cache(async (): Promise<RequestI18n> => {
  const { locales } = getDiscovery();
  const codes = locales.map((l) => l.code);
  const store = await cookies();
  const saved = readLocaleCookie(store.toString(), codes);
  // Order: the user's explicit choice → their browser → the instance's
  // default → English.
  const locale =
    saved ?? negotiateLocale((await headers()).get('accept-language'), codes, instanceDefaultLocale(codes));
  return {
    locale,
    info: locales.find((l) => l.code === locale) ?? FALLBACK_INFO,
    choice: saved ?? 'system',
    messages: loadMessages(locale),
    locales,
  };
});

/** The language for this request. */
export async function getRequestLocale(): Promise<string> {
  return (await getRequestI18n()).locale;
}

/** A translator bound to this request's language. */
export const getTranslator = cache(async (): Promise<Translator> => {
  const { locale, messages } = await getRequestI18n();
  return createTranslator(locale, messages);
});
