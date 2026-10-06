/**
 * Mail settings resolution (docs/EMAIL.md §3): the stored row, the preset
 * defaults, the environment overrides (locked fields, `custom` for a bare
 * env host, `off` as the emergency switch), the encrypted password, the
 * per-process cache, and enforced_since recorded when the env turns
 * `required` on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getInstanceMailSettings: vi.fn(),
  ensureEmailVerificationEnforcedSince: vi.fn(),
}));

vi.mock('@lobbyforge/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lobbyforge/db')>()),
  getInstanceMailSettings: h.getInstanceMailSettings,
  ensureEmailVerificationEnforcedSince: h.ensureEmailVerificationEnforcedSince,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));

import { defaultInstanceMailSettings, type InstanceMailSettings } from '@lobbyforge/db';
import { SMTP_SECRET_BOX, sealSecret } from '@/lib/secret-box';
import { buildResolvedMailSettings, invalidateMailSettingsCache, readMailEnvOverrides, resetMailSettingsCacheForTests, resolveMailSettings } from '../settings';

const ENV = [
  'LOBBYFORGE_MAIL_PROVIDER',
  'LOBBYFORGE_SMTP_HOST',
  'LOBBYFORGE_SMTP_PORT',
  'LOBBYFORGE_SMTP_SECURITY',
  'LOBBYFORGE_SMTP_USER',
  'LOBBYFORGE_SMTP_PASSWORD',
  'LOBBYFORGE_MAIL_FROM',
  'LOBBYFORGE_EMAIL_VERIFICATION',
];

function stored(overrides: Partial<InstanceMailSettings> = {}): InstanceMailSettings {
  return { ...defaultInstanceMailSettings(), ...overrides };
}

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'k'.repeat(48));
  for (const name of ENV) vi.stubEnv(name, '');
  h.getInstanceMailSettings.mockReset().mockResolvedValue(stored());
  h.ensureEmailVerificationEnforcedSince.mockReset().mockResolvedValue(new Date('2026-10-04T00:00:00Z'));
  resetMailSettingsCacheForTests();
});
afterEach(() => vi.unstubAllEnvs());

describe('buildResolvedMailSettings', () => {
  it('defaults: no transport, verification off, nothing locked', () => {
    const s = buildResolvedMailSettings(stored(), readMailEnvOverrides());
    expect(s).toMatchObject({
      provider: 'none',
      host: null,
      port: null,
      security: null,
      passwordState: 'unset',
      transportConfigured: false,
      verification: { mode: 'off', scope: { open_register: true, invite_register: false }, enforcedSince: null },
      disposable: { block: false, allow: [], blockExtra: [] },
      locked: { provider: false, host: false, port: false, security: false, username: false, password: false, from: false, verification: false },
    });
  });

  it('fills host, port and security from the preset and region', () => {
    const s = buildResolvedMailSettings(stored({ provider: 'ses', region: 'eu-west-1', mailFrom: 'LF <no-reply@example.org>' }), readMailEnvOverrides());
    expect(s).toMatchObject({ host: 'email-smtp.eu-west-1.amazonaws.com', port: 587, security: 'starttls', region: 'eu-west-1', transportConfigured: true });
    const tls = buildResolvedMailSettings(stored({ provider: 'custom', smtpHost: 'smtp.example.org', smtpPort: 465, mailFrom: 'a@example.org' }), readMailEnvOverrides());
    expect(tls).toMatchObject({ security: 'tls', transportConfigured: true });
    expect(buildResolvedMailSettings(stored({ provider: 'ses' }), readMailEnvOverrides()).transportConfigured).toBe(false); // no From
  });

  it('decrypts the stored password, and an undecryptable one leaves no usable transport', () => {
    const encrypted = sealSecret('smtp-secret-value', SMTP_SECRET_BOX);
    const base = { provider: 'brevo', mailFrom: 'a@example.org', smtpUsername: 'u@smtp-brevo.com' };
    const ok = buildResolvedMailSettings(stored({ ...base, smtpPasswordEncrypted: encrypted }), readMailEnvOverrides());
    expect(ok).toMatchObject({ password: 'smtp-secret-value', passwordState: 'ok', passwordHint: '…alue', transportConfigured: true });
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'z'.repeat(48));
    const broken = buildResolvedMailSettings(stored({ ...base, smtpPasswordEncrypted: encrypted }), readMailEnvOverrides());
    expect(broken).toMatchObject({ password: null, passwordState: 'undecryptable', transportConfigured: false });
  });

  it('environment values win and lock their fields; a bare env host means custom', () => {
    vi.stubEnv('LOBBYFORGE_SMTP_HOST', 'Mailpit');
    vi.stubEnv('LOBBYFORGE_SMTP_PORT', '1025');
    vi.stubEnv('LOBBYFORGE_SMTP_SECURITY', 'none');
    vi.stubEnv('LOBBYFORGE_MAIL_FROM', 'LobbyForge <no-reply@lobbyforge.test>');
    vi.stubEnv('LOBBYFORGE_SMTP_PASSWORD', 'from-env');
    const s = buildResolvedMailSettings(stored({ provider: 'ses', smtpHost: 'other', mailFrom: 'x@y.z' }), readMailEnvOverrides());
    expect(s).toMatchObject({
      provider: 'custom',
      host: 'mailpit',
      port: 1025,
      security: 'none',
      from: 'LobbyForge <no-reply@lobbyforge.test>',
      password: 'from-env',
      passwordState: 'ok',
      locked: { provider: true, host: true, port: true, security: true, password: true, from: true, username: false, verification: false },
    });
  });

  it('LOBBYFORGE_EMAIL_VERIFICATION=off is the emergency switch; invalid values are ignored and reported', () => {
    vi.stubEnv('LOBBYFORGE_EMAIL_VERIFICATION', 'off');
    expect(buildResolvedMailSettings(stored({ verificationMode: 'required' }), readMailEnvOverrides()).verification.mode).toBe('off');
    vi.stubEnv('LOBBYFORGE_EMAIL_VERIFICATION', 'strict');
    vi.stubEnv('LOBBYFORGE_SMTP_PORT', 'abc');
    vi.stubEnv('LOBBYFORGE_MAIL_PROVIDER', 'postal');
    const env = readMailEnvOverrides();
    expect(env.invalid.sort()).toEqual(['LOBBYFORGE_EMAIL_VERIFICATION', 'LOBBYFORGE_MAIL_PROVIDER', 'LOBBYFORGE_SMTP_PORT']);
    const s = buildResolvedMailSettings(stored({ verificationMode: 'optional' }), env);
    expect(s.verification.mode).toBe('optional');
    expect(s.locked.verification).toBe(false);
  });

  it('reads scope and disposable overrides tolerantly', () => {
    const s = buildResolvedMailSettings(
      stored({ verificationScope: { invite_register: true, junk: 1 }, disposableOverrides: { allow: [' OK.example ', 3, 'ok.example'], block: 'nope' } }),
      readMailEnvOverrides()
    );
    expect(s.verification.scope).toEqual({ open_register: true, invite_register: true });
    expect(s.disposable).toMatchObject({ allow: ['ok.example'], blockExtra: [] });
  });
});

describe('resolveMailSettings', () => {
  it('caches per process and refreshes after an invalidation', async () => {
    await resolveMailSettings();
    await resolveMailSettings();
    expect(h.getInstanceMailSettings).toHaveBeenCalledTimes(1);
    h.getInstanceMailSettings.mockResolvedValue(stored({ verificationMode: 'optional' }));
    invalidateMailSettingsCache();
    expect((await resolveMailSettings()).verification.mode).toBe('optional');
    expect((await resolveMailSettings({ fresh: true })).verification.mode).toBe('optional');
    expect(h.getInstanceMailSettings).toHaveBeenCalledTimes(3);
  });

  it('an unreadable row: defaults (no transport), the env mode still applies', async () => {
    h.getInstanceMailSettings.mockRejectedValue(new Error('db down'));
    vi.stubEnv('LOBBYFORGE_EMAIL_VERIFICATION', 'optional');
    const s = await resolveMailSettings();
    expect(s).toMatchObject({ loaded: false, provider: 'none', transportConfigured: false, verification: { mode: 'optional' } });
  });

  it('records enforced_since when the environment makes verification required', async () => {
    vi.stubEnv('LOBBYFORGE_EMAIL_VERIFICATION', 'required');
    const s = await resolveMailSettings();
    expect(h.ensureEmailVerificationEnforcedSince).toHaveBeenCalledTimes(1);
    expect(s.verification.enforcedSince?.toISOString()).toBe('2026-10-04T00:00:00.000Z');
    h.ensureEmailVerificationEnforcedSince.mockClear();
    h.getInstanceMailSettings.mockResolvedValue(stored({ verificationMode: 'required', enforcedSince: new Date('2026-09-01T00:00:00Z') }));
    invalidateMailSettingsCache();
    expect((await resolveMailSettings()).verification.enforcedSince?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(h.ensureEmailVerificationEnforcedSince).not.toHaveBeenCalled();
  });
});

describe('the last test fingerprint', () => {
  it('counts a test only for exactly the configuration in force (env included)', async () => {
    const { connectionOf, mailTestFingerprint } = await import('../settings');
    const row = stored({ provider: 'custom', smtpHost: 'smtp.example.org', smtpPort: 587, mailFrom: 'a@example.org', lastTestResult: 'ok' });
    const fingerprint = mailTestFingerprint(connectionOf(buildResolvedMailSettings(row, readMailEnvOverrides())))!;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(buildResolvedMailSettings({ ...row, lastTestFingerprint: fingerprint }, readMailEnvOverrides()).lastTest.current).toBe(true);
    // Another port, another From, an env password: not the tested configuration.
    expect(buildResolvedMailSettings({ ...row, smtpPort: 2525, lastTestFingerprint: fingerprint }, readMailEnvOverrides()).lastTest.current).toBe(false);
    expect(buildResolvedMailSettings({ ...row, mailFrom: 'b@example.org', lastTestFingerprint: fingerprint }, readMailEnvOverrides()).lastTest.current).toBe(false);
    vi.stubEnv('LOBBYFORGE_SMTP_PASSWORD', 'from-env');
    expect(buildResolvedMailSettings({ ...row, lastTestFingerprint: fingerprint }, readMailEnvOverrides()).lastTest.current).toBe(false);
    // Keyed by the session secret: the stored value gives no offline handle on the password.
    vi.stubEnv('LOBBYFORGE_SMTP_PASSWORD', '');
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'other-session-secret-of-enough-length!!');
    expect(mailTestFingerprint(connectionOf(buildResolvedMailSettings(row, readMailEnvOverrides())))).not.toBe(fingerprint);
  });
});
