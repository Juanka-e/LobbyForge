/**
 * The provider secret at rest (docs/CAPTCHA.md §3.3): AES-256-GCM under a
 * key derived from the session secret (HKDF-SHA256, info
 * "lobbyforge:captcha-secret:v1"), stored as `v1.<iv>.<ciphertext>.<tag>`
 * (base64url parts). It never goes back to a browser — the admin API shows
 * `secretHint` ("…abcd") at most.
 *
 * When the session secret changes, decryption fails: the provider is then
 * misconfigured (the app falls back to ALTCHA) and Doctor says so.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SECRET_KEY_INFO, deriveCaptchaKey } from './keys';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PART = /^[A-Za-z0-9_-]+$/;
/** Bound to its purpose: a ciphertext made for something else never decrypts here. */
const AAD = Buffer.from('lobbyforge:instance_settings.captcha_secret_encrypted');

export function encryptCaptchaSecret(plaintext: string): string {
  const key = deriveCaptchaKey(SECRET_KEY_INFO);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
}

/** The plaintext, or null when the value is malformed, tampered with or was encrypted under another session secret. */
export function decryptCaptchaSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION || !parts.slice(1).every((p) => PART.test(p))) return null;
  try {
    const key = deriveCaptchaKey(SECRET_KEY_INFO);
    const iv = Buffer.from(parts[1]!, 'base64url');
    const ciphertext = Buffer.from(parts[2]!, 'base64url');
    const tag = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** "…abcd" — the last four characters, only for a secret long enough that they give nothing away. */
export function captchaSecretHint(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null;
  return plaintext.length >= 12 ? `…${plaintext.slice(-4)}` : '…';
}
