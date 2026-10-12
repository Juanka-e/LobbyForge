/**
 * Which language a request is in — for pages (through `getRequestI18n`
 * in `./server`) and for route handlers that hold the Request. Server
 * only, but free of Next's request scope, so mail code and tests can
 * call it with a plain Request.
 *
 *   saved account language → `lf_locale` cookie → Accept-Language →
 *   instance default → English
 */
import { getUserLocale } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { getDiscovery } from './catalogue';
import { chooseLocale, installedLocale } from './core';
import { getInstanceDefaultLocale } from './instance-default';
import { readLocaleCookie } from './locale-cookie';

/**
 * The language the signed-in account saved (`users.locale`), when it is
 * still installed. Signed out, a guest cookie without an account row, or
 * no session secret: null, with no database read. Signed in: one
 * primary-key read of one column — the only lookup a request adds.
 *
 * The cookie's signature is checked (`readGuestSession`), but not the
 * revocation list: what this unlocks is the account's language and
 * nothing else, so a revoked-but-unexpired cookie rendering a page in its
 * owner's language is harmless, and skipping the check keeps Redis off
 * the render path.
 */
export async function accountLocale(cookieHeader: string | null, available: readonly string[]): Promise<string | null> {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!cookieHeader || !secret || secret.length < 32) return null;
  const uid = readGuestSession(cookieHeader, secret)?.uid;
  if (!uid) return null;
  try {
    return installedLocale(await getUserLocale(getDb(), uid), available);
  } catch {
    return null; // The database is down: the cookie and the browser still answer.
  }
}

/**
 * The resolution itself, for a page or a route handler alike:
 * saved account language → `lf_locale` → Accept-Language → instance
 * default → English (see `chooseLocale` and `instance-default.ts`).
 */
export async function resolveRequestLocale(
  cookieHeader: string | null,
  acceptLanguage: () => string | null | Promise<string | null>,
  available: readonly string[]
): Promise<{ locale: string; choice: string }> {
  const [account, fallback] = await Promise.all([
    accountLocale(cookieHeader, available),
    getInstanceDefaultLocale(available),
  ]);
  const cookie = readLocaleCookie(cookieHeader, available);
  return chooseLocale(available, {
    account,
    cookie,
    acceptLanguage: account || cookie ? null : await acceptLanguage(),
    fallback,
  });
}

/**
 * The same choice for a route handler that holds the Request (and runs in
 * tests without Next's request scope): the signed-in account's saved
 * language → `lf_locale` → Accept-Language → the instance default.
 *
 * Async since 0048 — it may read the account's saved language.
 */
export async function localeFromRequest(req: Request): Promise<string> {
  const codes = getDiscovery().locales.map((l) => l.code);
  const { locale } = await resolveRequestLocale(
    req.headers.get('cookie'),
    () => req.headers.get('accept-language'),
    codes
  );
  return locale;
}
