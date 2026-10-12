import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { getDiscovery, loadEnglishPlurals, loadMessages } from './catalogue';
import { SOURCE_LOCALE, createTranslator, type LocaleInfo, type Messages, type Translator } from './core';
import { resolveRequestLocale } from './request-locale';

export { getInstanceDefaultLocale, instanceDefaultLocale } from './instance-default';
export { localeFromRequest } from './request-locale';

/**
 * Everything the current request needs to know about language, for
 * server components. Wrapped in React's `cache`, so the layout, the page
 * and every nested server component share one resolution per request
 * instead of re-reading cookies and catalogues each time.
 */
export interface RequestI18n {
  locale: string;
  info: LocaleInfo;
  /**
   * What the user chose — their account's saved language, else this
   * browser's cookie — or "system" when following the browser.
   */
  choice: string;
  /** Resolved messages for `locale`, English filling every gap. */
  messages: Messages;
  /** Keys whose plural still reads in English (a partial translation). */
  englishPlurals: string[];
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

export const getRequestI18n = cache(async (): Promise<RequestI18n> => {
  const { locales } = getDiscovery();
  const codes = locales.map((l) => l.code);
  const cookieHeader = (await cookies()).toString();
  const { locale, choice } = await resolveRequestLocale(
    cookieHeader,
    async () => (await headers()).get('accept-language'),
    codes
  );
  return {
    locale,
    info: locales.find((l) => l.code === locale) ?? FALLBACK_INFO,
    choice,
    messages: loadMessages(locale),
    englishPlurals: loadEnglishPlurals(locale),
    locales,
  };
});

/** The language for this request. */
export async function getRequestLocale(): Promise<string> {
  return (await getRequestI18n()).locale;
}

/** A translator bound to this request's language. */
export const getTranslator = cache(async (): Promise<Translator> => {
  const { locale, messages, englishPlurals } = await getRequestI18n();
  return createTranslator(locale, messages, englishPlurals);
});
