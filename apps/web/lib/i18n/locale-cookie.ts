import {
  DEFAULT_APP_LOCALE,
  narrowToSupported,
  isAppLocale,
  type AppLocale,
} from '@/lib/app-locale';

/**
 * Where the server learns the language from.
 *
 * The language preference lived only in `localStorage`, which a server
 * render cannot see — so anything rendered on the server had no way to
 * be translated, and a client-side correction would have flashed English
 * first. A cookie is readable by both sides, so the very first byte of
 * HTML is already in the right language.
 *
 * It carries no personal data and is not a session: `SameSite=Lax` and
 * no `HttpOnly`, because the client writes it when the user changes the
 * setting.
 */
export const LOCALE_COOKIE = 'lf_locale';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function readLocaleCookie(cookieHeader: string | null | undefined): AppLocale | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== LOCALE_COOKIE) continue;
    const value = decodeURIComponent(rest.join('=')).toLowerCase();
    return isAppLocale(value) ? value : null;
  }
  return null;
}

/**
 * Negotiate a language from an `Accept-Language` header.
 *
 * Honours quality values, so a header like `fr;q=0.9, tr;q=0.8` picks
 * Turkish — the highest-ranked language we actually have, not the first
 * one listed.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): AppLocale {
  if (!acceptLanguage) return DEFAULT_APP_LOCALE;
  const ranked = acceptLanguage
    .split(',')
    .map((entry) => {
      const [tag, ...params] = entry.trim().split(';');
      const q = params
        .map((p) => /^\s*q=([0-9.]+)\s*$/i.exec(p))
        .find(Boolean);
      return { tag: tag?.trim() ?? '', quality: q ? Number(q[1]) : 1 };
    })
    .filter((entry) => entry.tag && !Number.isNaN(entry.quality))
    .sort((a, b) => b.quality - a.quality);
  for (const { tag } of ranked) {
    const supported = narrowToSupported(tag);
    if (supported) return supported;
  }
  return DEFAULT_APP_LOCALE;
}

export function serializeLocaleCookie(locale: AppLocale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}

/**
 * Drop the cookie, for "follow my browser".
 *
 * Pinning the resolved language would freeze it: the server would keep
 * serving Turkish after the user switched their browser to English,
 * because a concrete cookie always beats `Accept-Language`. With no
 * cookie the server negotiates afresh on every request, which is what
 * "follow my browser" means.
 */
export function clearLocaleCookie(): string {
  return `${LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}
