/**
 * The provider secret at rest (docs/CAPTCHA.md §3.3) and the phase 0
 * form checks (§7): formToken timing and the honeypot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captchaSecretHint, decryptCaptchaSecret, encryptCaptchaSecret } from '../secret';
import { checkFormToken, honeypotTripped, issueFormToken, FORM_TOKEN_MAX_AGE_MS, FORM_TOKEN_MIN_AGE_MS } from '../form';

const SECRET = 'k'.repeat(64);

beforeEach(() => vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET));
afterEach(() => vi.unstubAllEnvs());

describe('captcha secret encryption', () => {
  const plaintext = '0x4AAAAAAABBBBBBBBccccccccDDDDDDDDabcd';

  it('round-trips through v1.<iv>.<ciphertext>.<tag> (base64url), a fresh IV every time', () => {
    const a = encryptCaptchaSecret(plaintext);
    const b = encryptCaptchaSecret(plaintext);
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(plaintext);
    expect(decryptCaptchaSecret(a)).toBe(plaintext);
    expect(decryptCaptchaSecret(b)).toBe(plaintext);
  });

  it('matches the CHECK constraint of migration 0045', () => {
    expect(encryptCaptchaSecret(plaintext)).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('cannot be decrypted after the session secret changes', () => {
    const stored = encryptCaptchaSecret(plaintext);
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'other'.repeat(10));
    expect(decryptCaptchaSecret(stored)).toBeNull();
  });

  it('refuses tampered or malformed values', () => {
    const stored = encryptCaptchaSecret(plaintext);
    const [v, iv, ct, tag] = stored.split('.') as [string, string, string, string];
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(decryptCaptchaSecret([v, iv, flipped.toString('base64url'), tag].join('.'))).toBeNull();
    expect(decryptCaptchaSecret(`v2.${iv}.${ct}.${tag}`)).toBeNull();
    expect(decryptCaptchaSecret(`v1.${iv}.${ct}`)).toBeNull();
    expect(decryptCaptchaSecret('plain-secret')).toBeNull();
    expect(decryptCaptchaSecret(null)).toBeNull();
    expect(decryptCaptchaSecret('')).toBeNull();
  });

  it('shows at most the last four characters as a hint', () => {
    expect(captchaSecretHint(plaintext)).toBe('…abcd');
    expect(captchaSecretHint('short')).toBe('…');
    expect(captchaSecretHint(null)).toBeNull();
  });
});

describe('formToken (minimum fill time)', () => {
  const issued = Date.UTC(2026, 9, 4, 12, 0, 0);

  it('accepts a form sent between 2 s and 2 h after issue, for the same surface', () => {
    const token = issueFormToken('register', issued);
    expect(token).toMatch(/^\d{13}\.register\.[A-Za-z0-9_-]{43}$/);
    expect(checkFormToken(token, 'register', issued + FORM_TOKEN_MIN_AGE_MS)).toBe('ok');
    expect(checkFormToken(token, 'register', issued + 60_000)).toBe('ok');
    expect(checkFormToken(token, 'register', issued + FORM_TOKEN_MAX_AGE_MS)).toBe('ok');
  });

  it('refuses a form sent too fast or too late', () => {
    const token = issueFormToken('guest', issued);
    expect(checkFormToken(token, 'guest', issued + 1_999)).toBe('too_fast');
    expect(checkFormToken(token, 'guest', issued - 5_000)).toBe('too_fast');
    expect(checkFormToken(token, 'guest', issued + FORM_TOKEN_MAX_AGE_MS + 1)).toBe('expired');
  });

  it('refuses another surface, a moved timestamp, a forged MAC, and garbage', () => {
    const token = issueFormToken('invite_register', issued);
    expect(checkFormToken(token, 'register', issued + 10_000)).toBe('invalid');
    const [, surface, mac] = token.split('.');
    expect(checkFormToken(`${issued - 60_000}.${surface}.${mac}`, 'invite_register', issued + 10_000)).toBe('invalid');
    expect(checkFormToken(`${issued}.${surface}.${'A'.repeat(43)}`, 'invite_register', issued + 10_000)).toBe('invalid');
    expect(checkFormToken(`${issued}.register.${mac}`, 'register', issued + 10_000)).toBe('invalid');
    for (const bad of [undefined, null, '', 'x', 'a.b.c', `${issued}.login.${mac}`]) {
      expect(checkFormToken(bad, 'invite_register', issued + 10_000)).toBe('invalid');
    }
  });

  it('is bound to the session secret', () => {
    const token = issueFormToken('register', issued);
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'z'.repeat(40));
    expect(checkFormToken(token, 'register', issued + 10_000)).toBe('invalid');
  });
});

describe('honeypot', () => {
  it('trips on any non-blank value', () => {
    expect(honeypotTripped('https://spam.example')).toBe(true);
    expect(honeypotTripped('x')).toBe(true);
    expect(honeypotTripped('')).toBe(false);
    expect(honeypotTripped('   ')).toBe(false);
    expect(honeypotTripped(undefined)).toBe(false);
  });
});
