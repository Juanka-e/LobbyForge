'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createTranslator, type Translator } from './messages';
import { DEFAULT_APP_LOCALE, type AppLocale } from '@/lib/app-locale';

/**
 * The language for client components.
 *
 * Seeded by the server (see `getRequestLocale`) and passed down, rather
 * than re-detected in the browser — if the two disagreed, React would
 * throw a hydration mismatch on every translated string.
 */
const LocaleContext = createContext<AppLocale>(DEFAULT_APP_LOCALE);

export function I18nProvider({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): AppLocale {
  return useContext(LocaleContext);
}

/** `const t = useT()` — then `t('lobby.activities.title')`. */
export function useT(): Translator {
  const locale = useContext(LocaleContext);
  return useMemo(() => createTranslator(locale), [locale]);
}
