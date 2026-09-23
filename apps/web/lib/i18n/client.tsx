'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  SOURCE_LOCALE,
  createTranslator,
  type LocaleInfo,
  type Messages,
  type TextDirection,
  type Translator,
} from './core';

/**
 * Language for client components.
 *
 * Everything here arrives from the server (see `getRequestI18n` and the
 * root layout) rather than being re-detected in the browser: if the two
 * sides disagreed about the language, React would report a hydration
 * mismatch on every translated string.
 *
 * Only the ACTIVE language's messages are passed down, already merged
 * over English. The browser never downloads the other languages, so the
 * bundle does not grow as languages are added.
 */
interface I18nContextValue {
  locale: string;
  dir: TextDirection;
  messages: Messages;
  /** Keys whose plural still reads in English — see `englishPluralFallbacks`. */
  englishPlurals?: readonly string[];
  locales: LocaleInfo[];
  choice: string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: SOURCE_LOCALE,
  dir: 'ltr',
  messages: {},
  locales: [],
  choice: 'system',
});

export function I18nProvider({
  locale,
  dir,
  messages,
  englishPlurals,
  locales,
  choice,
  children,
}: I18nContextValue & { children: ReactNode }) {
  const value = useMemo(
    () => ({ locale, dir, messages, englishPlurals, locales, choice }),
    [locale, dir, messages, englishPlurals, locales, choice]
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useLocale(): string {
  return useContext(I18nContext).locale;
}

/** The languages on offer and the user's current choice — for the picker. */
export function useLocaleOptions(): { locales: LocaleInfo[]; choice: string; locale: string } {
  const { locales, choice, locale } = useContext(I18nContext);
  return { locales, choice, locale };
}

/** `const t = useT()` — then `t('lobby.activities.title')`. */
export function useT(): Translator {
  const { locale, messages, englishPlurals } = useContext(I18nContext);
  return useMemo(() => createTranslator(locale, messages, englishPlurals), [locale, messages, englishPlurals]);
}
