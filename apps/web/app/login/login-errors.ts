/**
 * Message keys for the `?error=` codes the auth routes redirect to
 * `/login` with (Google OAuth callback, session recording). Shared by the
 * self-hosted sign-in and the official hub's. Only KNOWN codes are shown —
 * the query value itself is never reflected into the page.
 */
const LOGIN_ERROR_KEYS: Record<string, string> = {
  registration_closed: 'auth.login.error.registrationClosed',
  oauth_failed: 'auth.login.error.oauthFailed',
  oauth_not_configured: 'auth.login.error.oauthNotConfigured',
  state_mismatch: 'auth.login.error.stateMismatch',
  missing_params: 'auth.login.error.missingParams',
  session_unavailable: 'auth.login.error.sessionUnavailable',
};

export function loginErrorKey(code: string | undefined): string | undefined {
  return code && Object.hasOwn(LOGIN_ERROR_KEYS, code) ? LOGIN_ERROR_KEYS[code] : undefined;
}

/**
 * Whole minutes to wait after a 429 (`retryAfter` seconds in the body of
 * the rate limiters and the per-account sign-in limit), at least one.
 */
export function retryAfterMinutes(retryAfterSeconds: unknown): number {
  const seconds = Number(retryAfterSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 1;
}
