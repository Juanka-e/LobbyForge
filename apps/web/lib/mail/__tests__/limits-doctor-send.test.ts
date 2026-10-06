/**
 * Rate limits (docs/EMAIL.md §4.4), the Doctor checks (§6) and `sendMail`
 * (§2.3: validation, the daily limit, failures counted with no address in
 * the log).
 */
import { AlertLevel } from '@lobbyforge/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolveMailSettings: vi.fn(),
  getPooledTransport: vi.fn(),
  send: vi.fn(),
}));

vi.mock('../settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings')>()),
  resolveMailSettings: h.resolveMailSettings,
}));
vi.mock('../transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../transport')>()),
  getPooledTransport: h.getPooledTransport,
}));
vi.mock('@lobbyforge/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lobbyforge/db')>()),
  getInstanceSetupStatus: async () => ({ instanceName: 'Test Guild' }),
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));

import { resetCaptchaMemoryForTests } from '@/lib/captcha/store';
import { buildMailChecks, type MailDoctorFacts } from '../doctor';
import {
  ACCOUNT_SEND_LIMITS,
  accountSubject,
  countHit,
  hitAddress,
  hitOver,
  peekAddress,
  rateLimitedResponse,
  reserveWindows,
  secondsUntilAllowed,
  SENDS_PER_ADDRESS,
  TARGET_HOURLY,
  targetSubject,
  changeSendEntries,
  verificationSendEntries,
} from '../limits';
import { mailAvailability, parseFromAddress, sendMail } from '../send';
import { mailFailureStats, sentToday } from '../stats';

function req(address?: string): Request {
  return new Request('https://x.example/', { headers: address ? { 'x-forwarded-for': address } : {} });
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'custom',
    host: '127.0.0.1',
    port: 587,
    security: 'starttls',
    username: 'u',
    password: 'p',
    passwordState: 'ok',
    from: 'LobbyForge <no-reply@example.org>',
    dailyLimit: null,
    transportConfigured: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'm'.repeat(48));
  resetCaptchaMemoryForTests();
  h.resolveMailSettings.mockReset().mockResolvedValue(settings());
  h.send.mockReset().mockResolvedValue({ ok: true, messageId: '<m@x>' });
  h.getPooledTransport.mockReset().mockResolvedValue({ ok: true, transport: { kind: 'smtp', send: h.send, verify: vi.fn(), close: vi.fn() }, address: '' });
});

describe('rate limits (§4.4)', () => {
  it('per account: one send a minute, five an hour, ten a day', async () => {
    const subject = accountSubject('u1');
    expect(await secondsUntilAllowed(ACCOUNT_SEND_LIMITS, subject)).toBe(0);
    const wait = await countHit(ACCOUNT_SEND_LIMITS, subject);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    expect(await secondsUntilAllowed(ACCOUNT_SEND_LIMITS, subject)).toBeGreaterThan(0);
    for (let i = 0; i < 4; i += 1) await countHit(ACCOUNT_SEND_LIMITS, subject);
    // Five in the hour: the next is an hour away, not a minute.
    expect(await secondsUntilAllowed(ACCOUNT_SEND_LIMITS, subject)).toBeGreaterThan(60);
    expect(await secondsUntilAllowed(ACCOUNT_SEND_LIMITS, accountSubject('u2'))).toBe(0);
  });

  it('the same target address: three an hour across accounts', async () => {
    const subject = targetSubject('Victim@Example.org');
    for (let i = 0; i < 3; i += 1) await countHit([TARGET_HOURLY], subject);
    expect(await secondsUntilAllowed([TARGET_HOURLY], targetSubject('victim@example.org'))).toBeGreaterThan(0);
  });

  it('per client address with a trusted proxy; one large backstop without', async () => {
    vi.stubEnv('LOBBYFORGE_TRUSTED_PROXY', 'x-forwarded-for');
    for (let i = 0; i < 10; i += 1) expect((await hitAddress(req('198.51.100.1'), SENDS_PER_ADDRESS)).over).toBe(false);
    expect((await hitAddress(req('198.51.100.1'), SENDS_PER_ADDRESS)).over).toBe(true);
    expect((await peekAddress(req('198.51.100.2'), SENDS_PER_ADDRESS)).over).toBe(false);
    vi.stubEnv('LOBBYFORGE_TRUSTED_PROXY', '');
    // Unknown addresses share the backstop (300 / 15 min), not a 10-request bucket.
    for (let i = 0; i < 11; i += 1) expect((await hitAddress(req(), SENDS_PER_ADDRESS)).over).toBe(false);
  });

  it('reserveWindows is all or nothing, and a concurrent burst gets exactly one send', async () => {
    const entries = verificationSendEntries('burst-user', 'burst@example.org');
    const results = await Promise.all(Array.from({ length: 12 }, () => reserveWindows(entries)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const granted = results.find((r) => r.ok)!;
    expect(granted.ok && granted.wait).toBeGreaterThan(50); // the 60 s cooldown is now running
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.retryAfter > 0)).toBe(true);
    // The refusals counted nothing: the hourly bucket holds exactly one send.
    expect(await secondsUntilAllowed([TARGET_HOURLY], targetSubject('burst@example.org'))).toBe(0);
  });

  it('a full target bucket refuses without counting the account’s buckets', async () => {
    const target = 'victim2@example.org';
    for (let i = 0; i < 3; i += 1) expect((await reserveWindows(verificationSendEntries(`attacker-${i}`, target))).ok).toBe(true);
    expect((await reserveWindows(verificationSendEntries('attacker-9', target))).ok).toBe(false);
    // attacker-9's own cooldown was not started by the refused attempt.
    expect(await secondsUntilAllowed(ACCOUNT_SEND_LIMITS, accountSubject('attacker-9'))).toBe(0);
  });

  it('change sends have their own account buckets; the target bucket is shared with verification sends', async () => {
    // A verification email was just sent: a change right after it is not held back by its cooldown.
    expect((await reserveWindows(verificationSendEntries('typo-user', 'tpyo@example.org'))).ok).toBe(true);
    expect((await reserveWindows(changeSendEntries('typo-user', 'typo@example.org'))).ok).toBe(true);
    // Each kind has its own cooldown.
    expect((await reserveWindows(changeSendEntries('typo-user', 'typo2@example.org'))).ok).toBe(false);
    expect((await reserveWindows(verificationSendEntries('typo-user', 'tpyo@example.org'))).ok).toBe(false);
    // The inbox is protected across both kinds: 3 an hour to one address.
    const inbox = 'shared-inbox@example.org';
    expect((await reserveWindows(verificationSendEntries('v1', inbox))).ok).toBe(true);
    expect((await reserveWindows(changeSendEntries('c1', inbox))).ok).toBe(true);
    expect((await reserveWindows(changeSendEntries('c2', inbox))).ok).toBe(true);
    expect((await reserveWindows(verificationSendEntries('v2', inbox))).ok).toBe(false);
    expect((await reserveWindows(changeSendEntries('c3', inbox))).ok).toBe(false);
  });

  it('hitOver counts and refuses past the limit; the 429 body is the contract’s', async () => {
    const limit = { name: 'probe', windowMs: 60_000, max: 2 };
    expect((await hitOver(limit, 's')).over).toBe(false);
    expect((await hitOver(limit, 's')).over).toBe(false);
    expect((await hitOver(limit, 's')).over).toBe(true);
    const res = rateLimitedResponse(42.2);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('43');
    expect(await res.json()).toEqual({ error: 'rate_limited', retryAfter: 43 });
  });
});

describe('sendMail (§2.3)', () => {
  it('validates the recipient and the From header before nodemailer sees them', async () => {
    expect(await sendMail({ to: 'not an address', template: 'test' })).toEqual({ ok: false, error: 'invalid_recipient' });
    expect(parseFromAddress('LobbyForge <No-Reply@Example.org>')).toEqual({ header: '"LobbyForge" <no-reply@example.org>', address: 'no-reply@example.org' });
    expect(parseFromAddress('a@example.org\r\nBcc: x@y.z')).toBeNull();
    expect(parseFromAddress('Evil "quote" <a@example.org>')).toBeNull();
    expect(parseFromAddress('nobody')).toBeNull();
    // An env file value that kept its quotes.
    expect(parseFromAddress('"LobbyForge <no-reply@example.org>"')).toEqual({ header: '"LobbyForge" <no-reply@example.org>', address: 'no-reply@example.org' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('sends the rendered template and counts it toward today', async () => {
    const result = await sendMail({ to: 'Member@Example.org', template: 'verify', locale: 'tr', vars: { code: '123456', link: null } });
    expect(result).toEqual({ ok: true, messageId: '<m@x>' });
    expect((await mailFailureStats()).lastSuccessAt).toBeGreaterThan(Date.now() - 5_000);
    const message = h.send.mock.calls[0]![0];
    expect(message).toMatchObject({ to: 'member@example.org', from: '"LobbyForge" <no-reply@example.org>', subject: 'E-posta adresini doğrula' });
    expect(message.text).toContain('123456');
    expect(message.text).toContain('Test Guild');
    expect(await sentToday()).toBe(1);
  });

  it('refuses without a transport, and at the daily limit', async () => {
    h.resolveMailSettings.mockResolvedValue(settings({ transportConfigured: false }));
    expect(await mailAvailability()).toBe('mail_unavailable');
    expect(await sendMail({ to: 'a@example.org', template: 'test' })).toMatchObject({ ok: false, error: 'mail_unavailable' });

    h.resolveMailSettings.mockResolvedValue(settings({ dailyLimit: 2 }));
    expect(await sendMail({ to: 'a@example.org', template: 'test' })).toMatchObject({ ok: true });
    expect(await sendMail({ to: 'a@example.org', template: 'test' })).toMatchObject({ ok: true });
    expect(await mailAvailability()).toBe('mail_quota');
    expect(await sendMail({ to: 'a@example.org', template: 'test' })).toEqual({ ok: false, error: 'mail_quota' });
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('counts failures (auth separately) for Doctor and never logs the address', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.send.mockResolvedValue({ ok: false, result: 'auth', detail: 'check_credentials', permanent: true });
    expect(await sendMail({ to: 'secret.person@example.org', template: 'test' })).toMatchObject({ ok: false, error: 'mail_unavailable', outcome: { result: 'auth' } });
    const stats = await mailFailureStats();
    expect(stats).toMatchObject({ failures: 1, authFailures: 1, last: { result: 'auth', detail: 'check_credentials' } });
    const logged = errors.mock.calls.flat().join(' ');
    expect(logged).not.toContain('secret.person');
    expect(logged).toContain('s***@example.org');
    errors.mockRestore();
  });
});

describe('Doctor (§6)', () => {
  const facts = (overrides: Partial<MailDoctorFacts> = {}): MailDoctorFacts => ({
    provider: 'ses',
    mode: 'optional',
    transportConfigured: true,
    passwordState: 'ok',
    port: 587,
    lastTestResult: 'ok',
    invalidEnv: [],
    settingsLoaded: true,
    failures: { failures: 0, authFailures: 0, last: null, lastSuccessAt: null },
    sentToday: 0,
    dailyLimit: null,
    production: true,
    dns: { domain: 'example.org', spf: true, dmarc: true },
    ...overrides,
  });
  const byId = (checks: ReturnType<typeof buildMailChecks>) => Object.fromEntries(checks.map((c) => [c.id, c]));

  it('healthy: one info line', () => {
    const checks = buildMailChecks(facts());
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ id: 'mail', ok: true, level: AlertLevel.INFO });
  });

  it('critical: required without a transport; an undecryptable password', () => {
    const checks = byId(buildMailChecks(facts({ mode: 'required', provider: 'none', transportConfigured: false, lastTestResult: null })));
    expect(checks.mail_transport).toMatchObject({ ok: false, level: AlertLevel.CRITICAL });
    expect(byId(buildMailChecks(facts({ passwordState: 'undecryptable', transportConfigured: false }))).mail_password).toMatchObject({ level: AlertLevel.CRITICAL });
  });

  it('warnings: failed or missing test, send and auth failures, 80% of the daily limit', () => {
    expect(byId(buildMailChecks(facts({ lastTestResult: 'auth' }))).mail_last_test).toMatchObject({ level: AlertLevel.WARNING });
    expect(byId(buildMailChecks(facts({ lastTestResult: null, mode: 'required' }))).mail_last_test).toMatchObject({ level: AlertLevel.WARNING });
    const failing = byId(buildMailChecks(facts({ failures: { failures: 3, authFailures: 2, last: { at: 1, result: 'auth' }, lastSuccessAt: null } })));
    expect(failing.mail_send_failures).toMatchObject({ level: AlertLevel.WARNING, detail: { failures: 3, authFailures: 2 } });
    expect(failing.mail_send_failures!.message).toContain('Email(s) that could not be sent in the last 24 hours: 3.');
    expect(byId(buildMailChecks(facts({ dailyLimit: 100, sentToday: 79 }))).mail_daily_limit).toBeUndefined();
    expect(byId(buildMailChecks(facts({ dailyLimit: 100, sentToday: 80 }))).mail_daily_limit).toMatchObject({ level: AlertLevel.WARNING });
    expect(byId(buildMailChecks(facts({ invalidEnv: ['LOBBYFORGE_SMTP_PORT'] }))).mail_env).toMatchObject({ level: AlertLevel.WARNING });
  });

  it('send failures are CRITICAL in required mode while nothing has gone out since', () => {
    const at = Date.now() - 60_000;
    const broken = byId(buildMailChecks(facts({ mode: 'required', failures: { failures: 2, authFailures: 0, last: { at, result: 'timeout' }, lastSuccessAt: at - 3_600_000 } })));
    expect(broken.mail_send_failures).toMatchObject({ level: AlertLevel.CRITICAL });
    const recovered = byId(buildMailChecks(facts({ mode: 'required', failures: { failures: 2, authFailures: 0, last: { at, result: 'timeout' }, lastSuccessAt: at + 1_000 } })));
    expect(recovered.mail_send_failures).toMatchObject({ level: AlertLevel.WARNING });
    const optional = byId(buildMailChecks(facts({ mode: 'optional', failures: { failures: 2, authFailures: 0, last: { at, result: 'timeout' }, lastSuccessAt: null } })));
    expect(optional.mail_send_failures).toMatchObject({ level: AlertLevel.WARNING });
  });

  it('hints (not ok, level info): port 25, missing SPF/DMARC, Gmail in production', () => {
    const checks = byId(buildMailChecks(facts({ port: 25, provider: 'gmail', dns: { domain: 'example.org', spf: false, dmarc: null } })));
    expect(checks.mail_port_25).toMatchObject({ ok: false, level: AlertLevel.INFO });
    expect(checks.mail_dns).toMatchObject({ ok: false, level: AlertLevel.INFO, detail: { spf: false, dmarc: null } });
    expect(checks.mail_dns!.message).toContain('SPF');
    expect(checks.mail_dns!.message).not.toContain('_dmarc');
    expect(checks.mail_gmail).toMatchObject({ ok: false, level: AlertLevel.INFO });
    // Hints alone still leave the summary line.
    expect(checks.mail).toMatchObject({ ok: true });
    expect(byId(buildMailChecks(facts({ provider: 'gmail', production: false }))).mail_gmail).toBeUndefined();
  });
});
