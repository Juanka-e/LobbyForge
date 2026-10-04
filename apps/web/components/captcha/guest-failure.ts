import { retryAfterMinutes } from '@/app/login/login-errors';
import type { Translator } from '@/lib/i18n/core';

/**
 * Why creating a guest failed, in the visitor's language. A rate limit
 * (429, `retryAfter` seconds in the body) says how long to wait — the
 * route's own body is English ("Rate limit exceeded") and is never shown.
 */
export function guestFailureMessage(t: Translator, status: number, body: Record<string, unknown>): string {
  if (status === 429) return t('auth.login.error.rateLimited', { minutes: retryAfterMinutes(body.retryAfter) });
  return t('captcha.guest.failed', { status });
}
