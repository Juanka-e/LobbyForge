/**
 * `lib/secret-box.ts` (docs/EMAIL.md §3.3): the cipher shared by the
 * CAPTCHA provider secret and the SMTP password.
 *
 * The compatibility vector below was produced by the CAPTCHA secret code
 * BEFORE the extraction (git history: lib/captcha/secret.ts with its own
 * AES-GCM, HKDF info "lobbyforge:captcha-secret:v1", AAD
 * "lobbyforge:instance_settings.captcha_secret_encrypted"). A secret an
 * admin saved then must still decrypt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPTCHA_SECRET_BOX, MissingSessionSecretError, SMTP_SECRET_BOX, openSecret, sealSecret, secretHint } from '../secret-box';
import { decryptCaptchaSecret, encryptCaptchaSecret } from '../captcha/secret';

const COMPAT_SESSION_SECRET = 'compat-session-secret-0123456789-abcdef';
const LEGACY_CAPTCHA_CIPHERTEXT = 'v1.9ZInMcSunA66u_FK.8SLH3YxeZp2j8jTpowe3KGsQmZxgQQwPxf2J02ERtanBCA.YGgdg39aQMTRLEWTfrtTeA';
const LEGACY_CAPTCHA_PLAINTEXT = '0x4AAAAAAA-legacy-turnstile-secret';

beforeEach(() => vi.stubEnv('LOBBYFORGE_SESSION_SECRET', COMPAT_SESSION_SECRET));
afterEach(() => vi.unstubAllEnvs());

describe('secret box', () => {
  it('decrypts a CAPTCHA secret stored before the extraction (label and AAD unchanged)', () => {
    expect(CAPTCHA_SECRET_BOX.info).toBe('lobbyforge:captcha-secret:v1');
    expect(decryptCaptchaSecret(LEGACY_CAPTCHA_CIPHERTEXT)).toBe(LEGACY_CAPTCHA_PLAINTEXT);
    expect(openSecret(LEGACY_CAPTCHA_CIPHERTEXT, CAPTCHA_SECRET_BOX)).toBe(LEGACY_CAPTCHA_PLAINTEXT);
  });

  it('keeps purposes apart: a CAPTCHA ciphertext never opens as the SMTP password, and back', () => {
    expect(SMTP_SECRET_BOX.info).toBe('lobbyforge:smtp-secret:v1');
    expect(openSecret(LEGACY_CAPTCHA_CIPHERTEXT, SMTP_SECRET_BOX)).toBeNull();
    const smtp = sealSecret('smtp-password-value', SMTP_SECRET_BOX);
    expect(openSecret(smtp, SMTP_SECRET_BOX)).toBe('smtp-password-value');
    expect(openSecret(smtp, CAPTCHA_SECRET_BOX)).toBeNull();
    expect(decryptCaptchaSecret(smtp)).toBeNull();
    // Same key label, different column: the AAD alone keeps them apart.
    expect(openSecret(smtp, { info: SMTP_SECRET_BOX.info, aad: 'lobbyforge:somewhere-else' })).toBeNull();
  });

  it('round-trips in the stored format with a fresh IV, and fails under another session secret', () => {
    const a = sealSecret('hunter2-but-longer', SMTP_SECRET_BOX);
    const b = sealSecret('hunter2-but-longer', SMTP_SECRET_BOX);
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
    expect(encryptCaptchaSecret('x'.repeat(20))).toMatch(/^v1\./);
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'another-session-secret-of-enough-length');
    expect(openSecret(a, SMTP_SECRET_BOX)).toBeNull();
  });

  it('refuses malformed values and needs a session secret to seal', () => {
    for (const bad of [null, undefined, '', 'v1.a.b', 'v2.a.b.c', 'v1.a.b.c', 'v1.!!.b.c', 'plaintext']) {
      expect(openSecret(bad as string | null | undefined, SMTP_SECRET_BOX)).toBeNull();
    }
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'short');
    expect(() => sealSecret('x', SMTP_SECRET_BOX)).toThrow(MissingSessionSecretError);
    expect(openSecret(LEGACY_CAPTCHA_CIPHERTEXT, CAPTCHA_SECRET_BOX)).toBeNull();
  });

  it('hints only the last four characters of a long secret', () => {
    expect(secretHint(null)).toBeNull();
    expect(secretHint('short')).toBe('…');
    expect(secretHint('abcdefghijkl1234')).toBe('…1234');
  });
});
