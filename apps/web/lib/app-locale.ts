/**
 * The document language — which is, today, the PLUGIN language.
 *
 * Plugins carry real translation tables (`@lobbyforge/plugin-sdk`'s
 * locale registry; Hushle, Poll and Dice Bot each ship `en` and `tr`),
 * and `detectLocale()` resolves them from `<html lang>`. The root layout
 * hardcoded `lang="en"` and nothing ever changed it, so every shipped
 * Turkish table was unreachable — the panels always rendered English no
 * matter where the user was.
 *
 * This resolves the language once, on the client, from an explicit
 * preference or the browser. `AppearanceRuntime` publishes the result
 * two ways: `data-lf-locale` for plugins, and a cookie so the SERVER
 * can translate the app's own chrome (see `lib/i18n`). The two have to
 * agree — if they drifted, a page would render its frame in one
 * language and the game inside it in another.
 */

/** Languages the bundled plugins actually ship tables for. */
export const APP_LOCALES = ['en', 'tr'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_APP_LOCALE: AppLocale = 'en';

/** `system` follows the browser; anything else is an explicit choice. */
export type AppLocaleChoice = AppLocale | 'system';

export const APP_LOCALE_LABELS: Record<AppLocale, string> = {
  en: 'English',
  tr: 'Türkçe',
};

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value);
}

export function coerceLocaleChoice(value: unknown): AppLocaleChoice {
  if (value === 'system') return 'system';
  return isAppLocale(value) ? value : 'system';
}

/**
 * Narrow a BCP-47 tag to a language we have tables for: `tr-TR` → `tr`,
 * `fr` → the default. Region tags are dropped, because the plugin
 * registry keys on the language alone.
 */
export function narrowToSupported(tag: string | null | undefined): AppLocale | null {
  if (!tag) return null;
  const language = tag.toLowerCase().split(/[-_]/)[0] ?? '';
  return isAppLocale(language) ? language : null;
}

/**
 * The language to put on `<html lang>`.
 *
 * An explicit choice wins. `system` walks the browser's ordered
 * preferences and takes the first one we support — so a user whose list
 * is `fr, tr, en` gets Turkish rather than falling straight to English.
 */
export function resolveAppLocale(
  choice: AppLocaleChoice,
  browserLanguages: readonly string[] = []
): AppLocale {
  if (choice !== 'system') return choice;
  for (const tag of browserLanguages) {
    const supported = narrowToSupported(tag);
    if (supported) return supported;
  }
  return DEFAULT_APP_LOCALE;
}
