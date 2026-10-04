/**
 * Phase 0 checks that need no captcha (docs/CAPTCHA.md §7):
 *
 * - `formToken` = `<issuedAt ms>.<surface>.<HMAC(issuedAt, surface)>`, the
 *   HMAC keyed with a key derived from the session secret. A form sent
 *   less than 2 s or more than 2 h after the token was issued, for another
 *   surface, or with a forged token, is refused (`form_rejected`).
 *   A form token is single use: `burnFormToken` marks it (Redis `SET NX`,
 *   TTL = its remaining lifetime) once the protected request succeeded —
 *   the same store policy as the ALTCHA replay marker (fail closed without
 *   Redis in production).
 * - The honeypot: the visually hidden `website` field must be empty or
 *   absent.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { FORM_TOKEN_INFO, deriveCaptchaKey } from './keys';
import { captchaKey, captchaStoreUsesRedis, memorySetNx, storeSetNx } from './store';
import { isCaptchaSurface, type FormCaptchaSurface } from './types';

export const FORM_TOKEN_MIN_AGE_MS = 2_000;
export const FORM_TOKEN_MAX_AGE_MS = 2 * 60 * 60_000;

function mac(issuedAt: number, surface: string): string {
  return createHmac('sha256', deriveCaptchaKey(FORM_TOKEN_INFO))
    .update(`${issuedAt}:${surface}`)
    .digest('base64url');
}

export function issueFormToken(surface: FormCaptchaSurface, now: number = Date.now()): string {
  return `${now}.${surface}.${mac(now, surface)}`;
}

export type FormTokenCheck = 'ok' | 'invalid' | 'too_fast' | 'expired';

export function checkFormToken(
  token: string | null | undefined,
  surface: FormCaptchaSurface,
  now: number = Date.now()
): FormTokenCheck {
  if (!token) return 'invalid';
  const parts = token.split('.');
  if (parts.length !== 3) return 'invalid';
  const [issuedRaw, tokenSurface, signature] = parts as [string, string, string];
  if (!/^\d{13}$/.test(issuedRaw) || !isCaptchaSurface(tokenSurface) || tokenSurface !== surface) return 'invalid';
  const issuedAt = Number(issuedRaw);
  const expected = Buffer.from(mac(issuedAt, surface));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  const age = now - issuedAt;
  if (age < FORM_TOKEN_MIN_AGE_MS) return 'too_fast';
  if (age > FORM_TOKEN_MAX_AGE_MS) return 'expired';
  return 'ok';
}

/** True when the honeypot was filled in (a bot). */
export function honeypotTripped(website: string | null | undefined): boolean {
  return typeof website === 'string' && website.trim().length > 0;
}

/**
 * Mark an (already checked) form token used. 'duplicate' when it was used
 * before; 'unavailable' when the replay store is down in production.
 */
export async function burnFormToken(token: string, now: number = Date.now()): Promise<'ok' | 'duplicate' | 'unavailable'> {
  const issuedAt = Number(token.split('.', 1)[0]);
  const ttlMs = Math.max(1_000, issuedAt + FORM_TOKEN_MAX_AGE_MS - now);
  const key = captchaKey(`form-used:${createHash('sha256').update(token).digest('hex')}`);
  try {
    return (await storeSetNx(key, '1', ttlMs)) ? 'ok' : 'duplicate';
  } catch (error) {
    console.error('[captcha] form token store unavailable', JSON.stringify((error as Error).message));
    if (process.env.NODE_ENV === 'production' && captchaStoreUsesRedis()) return 'unavailable';
    return memorySetNx(key, '1', ttlMs) ? 'ok' : 'duplicate';
  }
}
