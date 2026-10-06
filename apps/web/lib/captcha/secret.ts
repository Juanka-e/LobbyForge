/**
 * The provider secret at rest (docs/CAPTCHA.md §3.3): AES-256-GCM under a
 * key derived from the session secret (HKDF-SHA256, info
 * "lobbyforge:captcha-secret:v1"), stored as `v1.<iv>.<ciphertext>.<tag>`
 * (base64url parts). It never goes back to a browser — the admin API shows
 * `secretHint` ("…abcd") at most.
 *
 * The cipher lives in `lib/secret-box.ts` (shared with the SMTP password);
 * this purpose keeps its original label and associated data, so secrets
 * stored before the extraction still decrypt.
 *
 * When the session secret changes, decryption fails: the provider is then
 * misconfigured (the app falls back to ALTCHA) and Doctor says so.
 */
import { CAPTCHA_SECRET_BOX, openSecret, sealSecret, secretHint } from '@/lib/secret-box';

export function encryptCaptchaSecret(plaintext: string): string {
  return sealSecret(plaintext, CAPTCHA_SECRET_BOX);
}

/** The plaintext, or null when the value is malformed, tampered with or was encrypted under another session secret. */
export function decryptCaptchaSecret(stored: string | null | undefined): string | null {
  return openSecret(stored, CAPTCHA_SECRET_BOX);
}

/** "…abcd" — the last four characters, only for a secret long enough that they give nothing away. */
export function captchaSecretHint(plaintext: string | null | undefined): string | null {
  return secretHint(plaintext);
}
