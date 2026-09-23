import { LOCALE_CODE_PATTERN } from './core';

/**
 * The user's explicit language choice, readable by both sides.
 *
 * The server needs it to render the first byte of HTML in the right
 * language — a preference kept only in `localStorage` is invisible to a
 * server render, so the page would paint English and correct itself on
 * hydration. The client writes it when the user changes the setting.
 *
 * No cookie means "follow my browser": the server negotiates from
 * `Accept-Language` on every request. Storing the resolved language
 * instead would freeze today's answer — the server would keep serving
 * Turkish after the user switched their browser to English, because a
 * concrete cookie always beats the header.
 *
 * Holds a language code and nothing else: `SameSite=Lax`, and not
 * `HttpOnly`, because the client sets it.
 */
export const LOCALE_COOKIE = 'lf_locale';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * The saved choice, if it names a language that still exists. A cookie
 * for a language since removed from the instance is simply ignored.
 */
export function readLocaleCookie(
  cookieHeader: string | null | undefined,
  available: readonly string[]
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== LOCALE_COOKIE) continue;
    let value: string;
    try {
      value = decodeURIComponent(rest.join('=')).trim();
    } catch {
      return null;
    }
    if (!LOCALE_CODE_PATTERN.test(value)) return null;
    // Exact only: the user picked THIS language, not a relative of it.
    return available.find((code) => code.toLowerCase() === value.toLowerCase()) ?? null;
  }
  return null;
}

export function serializeLocaleCookie(code: string): string {
  return `${LOCALE_COOKIE}=${encodeURIComponent(code)}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}

/** "Follow my browser" — see the note at the top of this file. */
export function clearLocaleCookie(): string {
  return `${LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

