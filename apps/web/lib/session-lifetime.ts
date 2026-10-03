/**
 * Absolute session lifetime (security follow-up 2026-10).
 *
 * `POST /api/auth/guest` refreshes the session cookie, and it used to do so
 * forever: whoever held a cookie — including a stolen one — could keep it
 * alive indefinitely. Every session now carries `auth_time` (when it was
 * first issued) and cannot outlive `auth_time + sessionMaxAgeSeconds()`:
 * refreshes stop extending it and every reader in the web app treats an
 * over-age session as signed out. Applies to guest sessions too — their
 * identity IS the cookie.
 *
 * Configured with `LOBBYFORGE_SESSION_MAX_AGE_DAYS` (default 30, fractions
 * allowed, clamped to 1 hour … 365 days). See docs/GUEST_AUTH.md.
 */
import { GUEST_SESSION_MAX_AGE_SECONDS } from '@lobbyforge/core';

export const SESSION_MAX_AGE_ENV = 'LOBBYFORGE_SESSION_MAX_AGE_DAYS';

const MIN_MAX_AGE_SECONDS = 60 * 60;
const MAX_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

let warnedInvalidValue: string | null = null;

/** The absolute session lifetime in seconds. */
export function sessionMaxAgeSeconds(raw: string | undefined = process.env[SESSION_MAX_AGE_ENV]): number {
  if (raw === undefined || raw.trim() === '') return GUEST_SESSION_MAX_AGE_SECONDS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    // Once per distinct bad value, not once per request.
    if (warnedInvalidValue !== raw) {
      warnedInvalidValue = raw;
      console.warn(
        `[security] ${SESSION_MAX_AGE_ENV}="${raw}" is not a positive number of days — using the default (30).`
      );
    }
    return GUEST_SESSION_MAX_AGE_SECONDS;
  }
  return Math.min(MAX_MAX_AGE_SECONDS, Math.max(MIN_MAX_AGE_SECONDS, Math.round(days * 24 * 60 * 60)));
}
