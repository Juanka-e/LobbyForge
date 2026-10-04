/**
 * Every key the bot protection uses is DERIVED from the session secret with
 * HKDF-SHA256 and its own `info` label, so none of them can be confused
 * with (or help forge) a session MAC, a device cookie or another one of
 * these keys. Server-only.
 */
import { hkdfSync } from 'node:crypto';

/** §3.3 — AES-256-GCM key for the stored provider secret. */
export const SECRET_KEY_INFO = 'lobbyforge:captcha-secret:v1';
/** §4.2 — HMAC key that signs ALTCHA challenges. */
export const ALTCHA_SIGNATURE_INFO = 'lobbyforge:altcha:v1';
/** §4.2 — HMAC key that signs the expected derived key (ALTCHA v2 deterministic mode). */
export const ALTCHA_KEY_SIGNATURE_INFO = 'lobbyforge:altcha:key:v1';
/** §7 — HMAC key of the minimum-fill-time `formToken`. */
export const FORM_TOKEN_INFO = 'lobbyforge:captcha-form-token:v1';

export class MissingSessionSecretError extends Error {
  constructor() {
    super('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
    this.name = 'MissingSessionSecretError';
  }
}

function sessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new MissingSessionSecretError();
  return secret;
}

/** HKDF-SHA256(session secret, no salt, info) — throws MissingSessionSecretError without a usable secret. */
export function deriveCaptchaKey(info: string, length = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', sessionSecret(), Buffer.alloc(0), info, length));
}
