/**
 * A secret at rest in `instance_settings` (docs/CAPTCHA.md §3.3,
 * docs/EMAIL.md §3.3): AES-256-GCM under a key derived from the session
 * secret with HKDF-SHA256 and a PURPOSE label, stored as
 * `v1.<iv>.<ciphertext>.<tag>` (base64url parts). Server-only.
 *
 * Each purpose has its own key (the HKDF `info`) and its own additional
 * authenticated data (the column it lives in), so a ciphertext made for one
 * purpose never decrypts as another:
 *
 *   CAPTCHA_SECRET_BOX — lobbyforge:captcha-secret:v1  (unchanged since 0045,
 *                        so stored CAPTCHA secrets still decrypt)
 *   SMTP_SECRET_BOX    — lobbyforge:smtp-secret:v1
 *
 * The plaintext never goes back to a browser — the admin APIs show a hint
 * ("…abcd") at most. When the session secret changes, decryption fails and
 * the feature treats the secret as unusable (Doctor says so).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export interface SecretBoxPurpose {
  /** HKDF-SHA256 `info`: the key is derived per purpose. */
  info: string;
  /** AES-GCM additional data: binds the ciphertext to the column it is stored in. */
  aad: string;
}

export const CAPTCHA_SECRET_BOX: SecretBoxPurpose = Object.freeze({
  info: 'lobbyforge:captcha-secret:v1',
  aad: 'lobbyforge:instance_settings.captcha_secret_encrypted',
});

export const SMTP_SECRET_BOX: SecretBoxPurpose = Object.freeze({
  info: 'lobbyforge:smtp-secret:v1',
  aad: 'lobbyforge:instance_settings.smtp_password_encrypted',
});

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PART = /^[A-Za-z0-9_-]+$/;

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
export function deriveSessionKey(info: string, length = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', sessionSecret(), Buffer.alloc(0), info, length));
}

/** Encrypt for `purpose`. Throws MissingSessionSecretError without a session secret. */
export function sealSecret(plaintext: string, purpose: SecretBoxPurpose): string {
  const key = deriveSessionKey(purpose.info);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(purpose.aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
}

/** The plaintext, or null when the value is malformed, tampered with, for another purpose or under another session secret. */
export function openSecret(stored: string | null | undefined, purpose: SecretBoxPurpose): string | null {
  if (!stored) return null;
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION || !parts.slice(1).every((p) => PART.test(p))) return null;
  try {
    const key = deriveSessionKey(purpose.info);
    const iv = Buffer.from(parts[1]!, 'base64url');
    const ciphertext = Buffer.from(parts[2]!, 'base64url');
    const tag = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(purpose.aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** "…abcd" — the last four characters, only for a secret long enough that they give nothing away. */
export function secretHint(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null;
  return plaintext.length >= 12 ? `…${plaintext.slice(-4)}` : '…';
}
