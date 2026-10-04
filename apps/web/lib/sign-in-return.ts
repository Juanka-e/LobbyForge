/**
 * Signing in and coming back: `/login?next=<path>`.
 *
 * A page that finds its visitor signed out sends them to sign in with the
 * page they wanted; after signing in they land back there instead of on
 * the default (the lobby, or the hub home). The path is read back with the
 * same rules as the Google sign-in's `?redirect=` (`sanitizeOAuthRedirect`):
 * a same-origin path only, so `next` can never send anyone off-site.
 */
import { SIGN_IN_PATH } from './hub-routes';
import { sanitizeOAuthRedirect } from './oauth-redirect';

/** Pages that would only bounce the visitor back to signing in. */
const SIGN_IN_PAGES = /^\/(login|register|setup)(\/|$)/;

/** Where to go after signing in: `raw` when it is a safe path to come back to, else `fallback`. */
export function signInReturnPath<T extends string | null>(raw: string | null | undefined, fallback: T): string | T {
  const path = sanitizeOAuthRedirect(raw, '');
  if (!path) return fallback;
  const pathname = path.split(/[?#]/, 1)[0] ?? '';
  return SIGN_IN_PAGES.test(pathname) ? fallback : path;
}

/** The sign-in link for a visitor who wanted `path` (a pathname, optionally with its query). */
export function signInHref(path: string | null | undefined): string {
  const next = signInReturnPath(path, '');
  return next ? `${SIGN_IN_PATH}?next=${encodeURIComponent(next)}` : SIGN_IN_PATH;
}

/** The current page, as `signInHref` wants it (browser only). */
export function currentPagePath(): string {
  return `${window.location.pathname}${window.location.search}`;
}
