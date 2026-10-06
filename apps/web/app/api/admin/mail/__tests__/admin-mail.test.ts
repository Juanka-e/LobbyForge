/**
 * Admin email API (docs/EMAIL.md §5): GET / PUT /api/admin/mail, POST
 * /api/admin/mail/test and POST /api/admin/users/{id}/verify-email —
 * owner-only, the password write-only (encrypted at rest, never returned,
 * never audited), environment locks, the host rules, `required` only after
 * a passing test of the saved settings, classified test results.
 */
import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredMail, createFakeEmailDb } from '@/lib/mail/__tests__/fake-db';

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeEmailDb> }));
const h = vi.hoisted(() => ({
  requireInstanceAdmin: vi.fn(),
  logAction: vi.fn(),
  createSmtpTransport: vi.fn(),
  verify: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@lobbyforge/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lobbyforge/db')>();
  const { createFakeEmailDb: create } = await import('@/lib/mail/__tests__/fake-db');
  fake.db = create();
  return { ...actual, ...fake.db.fns, logAction: h.logAction };
});
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/admin-auth', () => ({ requireInstanceAdmin: h.requireInstanceAdmin }));
vi.mock('@/lib/security-headers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security-headers')>()),
  withApiSecurity: (handler: unknown) => handler,
}));
vi.mock('@/lib/mail/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mail/transport')>()),
  createSmtpTransport: h.createSmtpTransport,
}));

import { resetCaptchaMemoryForTests } from '@/lib/captcha/store';
import { buildGuestSessionCookie } from '@/lib/guest-session';
import { resetMailSettingsCacheForTests } from '@/lib/mail/settings';
import { SMTP_SECRET_BOX, openSecret, sealSecret } from '@/lib/secret-box';

const SECRET = 'a'.repeat(48);
const OWNER = '22222222-2222-4222-8222-222222222222';
const MEMBER = '12121212-1212-4212-8212-121212121212';

function ownerCookie(): string {
  return `lf_guest=${buildGuestSessionCookie({ gid: 'g_'.padEnd(34, 'a'), uid: OWNER, name: 'Owner' }, SECRET).raw}`;
}

function request(path: string, method: string, body?: unknown, signedIn = true): Request {
  return new Request(`https://community.example${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(signedIn ? { cookie: ownerCookie() } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const get = async () => (await import('../route')).GET(request('/api/admin/mail', 'GET'), {});
const put = async (body: unknown) => (await import('../route')).PUT(request('/api/admin/mail', 'PUT', body), {});
const test = async (body: unknown, signedIn = true) => (await import('../test/route')).POST(request('/api/admin/mail/test', 'POST', body, signedIn), {});
const verifyUser = async (id: string) =>
  (await import('../../users/[id]/verify-email/route')).POST(request(`/api/admin/users/${id}/verify-email`, 'POST', {}), { params: Promise.resolve({ id }) });

const base = {
  provider: 'none',
  region: null,
  host: null,
  port: null,
  security: null,
  username: null,
  from: null,
  dailyLimit: null,
  verification: { mode: 'off', scope: { open_register: true, invite_register: false }, existingDeadline: null },
  disposable: { block: false, allow: [], blockExtra: [] },
};

const ses = {
  ...base,
  provider: 'ses',
  region: 'eu-central-1',
  host: 'email-smtp.eu-central-1.amazonaws.com',
  port: 587,
  security: 'starttls',
  username: 'AKIAEXAMPLEUSER',
  password: 'BMb7-a-very-SECRET-smtp-password',
  from: 'LobbyForge <no-reply@lobbyforge.example>',
};

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  vi.stubEnv('NODE_ENV', 'test');
  for (const name of ['LOBBYFORGE_MAIL_PROVIDER', 'LOBBYFORGE_SMTP_HOST', 'LOBBYFORGE_SMTP_PORT', 'LOBBYFORGE_SMTP_SECURITY', 'LOBBYFORGE_SMTP_USER', 'LOBBYFORGE_SMTP_PASSWORD', 'LOBBYFORGE_MAIL_FROM', 'LOBBYFORGE_EMAIL_VERIFICATION', 'LOBBYFORGE_DEPLOYMENT_MODE']) {
    vi.stubEnv(name, '');
  }
  fake.db.reset();
  fake.db.state.ownerUserId = OWNER;
  fake.db.addUser({ id: OWNER, email: 'owner@example.org', emailVerifiedAt: new Date() });
  h.requireInstanceAdmin.mockReset().mockResolvedValue(null);
  h.logAction.mockReset().mockResolvedValue(undefined);
  h.verify.mockReset().mockResolvedValue({ ok: true });
  h.send.mockReset().mockResolvedValue({ ok: true, messageId: '<t@x>' });
  h.createSmtpTransport.mockReset().mockResolvedValue({ ok: true, transport: { kind: 'smtp', verify: h.verify, send: h.send, close: vi.fn() }, address: '203.0.113.1' });
  resetMailSettingsCacheForTests();
  resetCaptchaMemoryForTests();
});

describe('GET /api/admin/mail', { timeout: 20_000 }, () => {
  it('is owner only', async () => {
    h.requireInstanceAdmin.mockResolvedValue(NextResponse.json({ error: 'Instance owner authentication required' }, { status: 401 }));
    expect((await get()).status).toBe(401);
    expect((await put(base)).status).toBe(401);
    expect((await test({})).status).toBe(401);
    expect((await verifyUser(MEMBER)).status).toBe(401);
  });

  it('answers the contract shape for a fresh install', async () => {
    const res = await get();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      provider: 'none',
      region: null,
      host: null,
      port: null,
      security: null,
      username: null,
      passwordSet: false,
      passwordHint: null,
      from: null,
      dailyLimit: null,
      sentToday: 0,
      lastTest: { at: null, result: null },
      verification: { mode: 'off', scope: { open_register: true, invite_register: false }, enforcedSince: null, existingDeadline: null },
      disposable: { block: false, allow: [], blockExtra: [] },
      locked: { provider: false, host: false, port: false, security: false, username: false, password: false, from: false, verification: false },
    });
  });
});

describe('PUT /api/admin/mail', { timeout: 20_000 }, () => {
  it('saves, keeps the password write-only (encrypted at rest) and audits field NAMES only', async () => {
    const res = await put(ses);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('SECRET-smtp-password');
    expect(JSON.parse(text)).toMatchObject({ provider: 'ses', region: 'eu-central-1', port: 587, passwordSet: true, passwordHint: '…word' });
    const stored = fake.db.state.settings.smtpPasswordEncrypted!;
    expect(stored).toMatch(/^v1\./);
    expect(openSecret(stored, SMTP_SECRET_BOX)).toBe(ses.password);
    expect(h.logAction).toHaveBeenCalledTimes(1);
    const entry = h.logAction.mock.calls[0]![1];
    expect(entry).toMatchObject({ action: 'instance.mail_updated', actorUserId: OWNER, targetType: 'instance' });
    expect(entry.metadata.fields).toEqual(expect.arrayContaining(['provider', 'region', 'host', 'port', 'security', 'username', 'password', 'from']));
    expect(JSON.stringify(entry)).not.toContain('SECRET');

    // Omitted keeps the password; null clears it; no change, no audit.
    h.logAction.mockClear();
    const { password: _p, ...withoutPassword } = ses;
    expect(await (await put(withoutPassword)).json()).toMatchObject({ passwordSet: true });
    expect(h.logAction).not.toHaveBeenCalled();
    expect(await (await put({ ...withoutPassword, password: null })).json()).toMatchObject({ passwordSet: false });
  });

  it('validates: issues without values, the From address, unknown regions, domain lists', async () => {
    const bad = await put({ ...ses, port: 'x', password: 'hunter2-secret' });
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.error).toBe('invalid_settings');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(await (await put({ ...ses, from: 'not an address' })).json()).toMatchObject({ error: 'invalid_settings', issues: [{ path: 'from' }] });
    expect(await (await put({ ...ses, region: 'mars-1' })).json()).toMatchObject({ error: 'invalid_settings', issues: [{ path: 'region' }] });
    expect(await (await put({ ...ses, disposable: { block: true, allow: ['ok.example', 'not a domain'], blockExtra: [] } })).json()).toMatchObject({
      error: 'invalid_settings',
      issues: [{ path: 'disposable.allow.1' }],
    });
  });

  it('refuses a host outside the §3.4 rules', async () => {
    const port = await put({ ...ses, provider: 'custom', host: 'smtp.example.org', port: 8080 });
    expect(port.status).toBe(400);
    expect(await port.json()).toEqual({ error: 'host_not_allowed', detail: 'port_not_allowed' });
    expect(await (await put({ ...ses, provider: 'custom', host: '169.254.169.254' })).json()).toEqual({ error: 'host_not_allowed', detail: 'address_not_allowed' });
    expect(await (await put({ ...ses, provider: 'custom', host: 'smtp.example.org', security: 'none' })).json()).toEqual({
      error: 'host_not_allowed',
      detail: 'security_not_allowed',
    });
  });

  it('environment values lock their fields: the same value is fine, a different one is 409', async () => {
    vi.stubEnv('LOBBYFORGE_SMTP_HOST', 'smtp.relay.example');
    vi.stubEnv('LOBBYFORGE_SMTP_PASSWORD', 'from-the-env');
    vi.stubEnv('LOBBYFORGE_EMAIL_VERIFICATION', 'optional');
    resetMailSettingsCacheForTests();
    const view = await (await get()).json();
    expect(view).toMatchObject({ provider: 'custom', host: 'smtp.relay.example', passwordSet: true, locked: { provider: true, host: true, password: true, verification: true } });
    const same = { ...base, provider: 'custom', host: 'smtp.relay.example', port: 587, security: 'starttls', from: 'a@example.org', verification: { ...base.verification, mode: 'optional' } };
    expect((await put(same)).status).toBe(200);
    expect(fake.db.state.settings.smtpHost).toBeNull(); // an env value is never copied into the database
    expect(await (await put({ ...same, host: 'other.example' })).json()).toEqual({ error: 'locked_by_env', field: 'host' });
    expect(await (await put({ ...same, password: 'new' })).json()).toEqual({ error: 'locked_by_env', field: 'password' });
    expect(await (await put({ ...same, verification: { ...same.verification, mode: 'required' } })).json()).toEqual({ error: 'locked_by_env', field: 'verification' });
  });

  it('required needs a transport and a passing test of the SAVED settings; it records enforced_since once', async () => {
    const required = { ...base, verification: { ...base.verification, mode: 'required' } };
    expect(await (await put(required)).json()).toEqual({ error: 'transport_required' });
    expect((await put(ses)).status).toBe(200);
    expect(await (await put({ ...ses, verification: required.verification })).json()).toEqual({ error: 'test_required' });

    expect(await (await test({})).json()).toEqual({ result: 'ok' });
    expect(fake.db.state.settings.lastTestResult).toBe('ok');
    const { password: _p, ...saved } = ses;
    // Changing the connection in the same save makes the test stale.
    expect(await (await put({ ...saved, port: 2587, verification: required.verification })).json()).toEqual({ error: 'test_required' });
    // A passing test more than a day old no longer counts (credentials may have been revoked since).
    const testedAt = fake.db.state.settings.lastTestAt;
    fake.db.state.settings.lastTestAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    expect(await (await put({ ...saved, verification: required.verification })).json()).toEqual({ error: 'test_required' });
    fake.db.state.settings.lastTestAt = testedAt;
    const ok = await put({ ...saved, verification: required.verification });
    expect(ok.status).toBe(200);
    const view = await ok.json();
    expect(view.verification.mode).toBe('required');
    expect(Date.parse(view.verification.enforcedSince)).toBeLessThanOrEqual(Date.now());
    // Once required, a connection change is saved, and the last test no longer describes it.
    const changed = await (await put({ ...saved, port: 2587, verification: required.verification })).json();
    expect(changed).toMatchObject({ port: 2587, lastTest: { at: null, result: null }, verification: { mode: 'required', enforcedSince: view.verification.enforcedSince } });
    // …and changing it back makes the recorded test current again (same fingerprint).
    expect(await (await put({ ...saved, verification: required.verification })).json()).toMatchObject({ lastTest: { result: 'ok' } });
  });

  it('saves verification scope, deadline, daily limit and the disposable lists', async () => {
    const res = await put({
      ...base,
      dailyLimit: 250,
      verification: { mode: 'optional', scope: { open_register: true, invite_register: true }, existingDeadline: '2026-12-31T20:59:59.000Z' },
      disposable: { block: true, allow: [' OK.Example '], blockExtra: ['@spam.example'] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      dailyLimit: 250,
      verification: { mode: 'optional', scope: { open_register: true, invite_register: true }, existingDeadline: '2026-12-31T20:59:59.000Z' },
      disposable: { block: true, allow: ['ok.example'], blockExtra: ['spam.example'] },
    });
    expect(h.logAction.mock.calls[0]![1].metadata.fields).toEqual(
      expect.arrayContaining(['dailyLimit', 'verificationMode', 'verificationScope', 'existingDeadline', 'disposableBlock', 'disposableAllow', 'disposableBlockExtra'])
    );
  });

  it('503 settings_unavailable when the row cannot be read — never a save against the defaults', async () => {
    fake.db.state.settingsUnreadable = true;
    resetMailSettingsCacheForTests();
    const res = await put(ses);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'settings_unavailable' });
    expect(h.logAction).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/mail/test', { timeout: 20_000 }, () => {
  it('not_configured without a transport; missing_recipient without an admin address', async () => {
    expect(await (await test({})).json()).toEqual({ result: 'not_configured' });
    fake.db.state.settings = configuredMail();
    resetMailSettingsCacheForTests();
    expect(await (await test({}, false)).json()).toEqual({ result: 'not_configured', detail: 'missing_recipient' });
  });

  it('records the result only for the SAVED settings; unsaved overrides are tested, not recorded', async () => {
    fake.db.state.settings = configuredMail();
    resetMailSettingsCacheForTests();
    h.verify.mockResolvedValue({ ok: false, result: 'auth', detail: 'check_credentials' });
    expect(await (await test({})).json()).toEqual({ result: 'auth', detail: 'check_credentials' });
    expect(fake.db.state.settings.lastTestResult).toBe('auth');

    h.verify.mockResolvedValue({ ok: true });
    const res = await test({ to: 'someone@example.org', host: 'smtp.other.example', port: 2525, security: 'starttls', password: 'unsaved' });
    expect(await res.json()).toEqual({ result: 'ok' });
    expect(fake.db.state.settings.lastTestResult).toBe('auth');
    expect(h.createSmtpTransport.mock.calls.at(-1)![0]).toMatchObject({ host: 'smtp.other.example', port: 2525, password: 'unsaved' });
    expect(h.send.mock.calls.at(-1)![0]).toMatchObject({ to: 'someone@example.org' });
    expect(h.send.mock.calls.at(-1)![0].subject).toContain('Test Guild');
  });

  it('passes through host refusals and send failures as codes', async () => {
    fake.db.state.settings = configuredMail();
    resetMailSettingsCacheForTests();
    h.createSmtpTransport.mockResolvedValueOnce({ ok: false, outcome: { result: 'host_not_allowed', detail: 'address_not_allowed' } });
    expect(await (await test({})).json()).toEqual({ result: 'host_not_allowed', detail: 'address_not_allowed' });
    h.send.mockResolvedValueOnce({ ok: false, result: 'sender_rejected', detail: 'sender_domain', permanent: true });
    expect(await (await test({})).json()).toEqual({ result: 'sender_rejected', detail: 'sender_domain' });
    // The saved password cannot be decrypted.
    fake.db.state.settings = configuredMail({ smtpUsername: 'u', smtpPasswordEncrypted: sealSecret('x'.repeat(16), SMTP_SECRET_BOX) });
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'b'.repeat(48));
    resetMailSettingsCacheForTests();
    const res = await (await import('../test/route')).POST(
      new Request('https://community.example/api/admin/mail/test', { method: 'POST', body: JSON.stringify({ to: 'a@example.org' }) }),
      {}
    );
    expect(await res.json()).toEqual({ result: 'not_configured', detail: 'password_undecryptable' });
  });
});

describe('POST /api/admin/users/{id}/verify-email', { timeout: 20_000 }, () => {
  it('marks the account verified and audits it once', async () => {
    fake.db.addUser({ id: MEMBER, email: 'member@example.org' });
    const res = await verifyUser(MEMBER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: true });
    expect(fake.db.users.get(MEMBER)!.emailVerifiedAt).toBeInstanceOf(Date);
    expect(h.logAction).toHaveBeenCalledWith({}, expect.objectContaining({ action: 'user.email_verified_by_admin', targetType: 'user', targetId: MEMBER, actorUserId: OWNER }));
    h.logAction.mockClear();
    expect((await verifyUser(MEMBER)).status).toBe(200);
    expect(h.logAction).not.toHaveBeenCalled();
  });

  it('404 for an unknown account, 400 no_email for a guest', async () => {
    expect((await verifyUser('99999999-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await verifyUser('not-a-uuid')).status).toBe(404);
    fake.db.addUser({ id: MEMBER, email: null, isGuest: true });
    expect(await (await verifyUser(MEMBER)).json()).toEqual({ error: 'no_email' });
  });
});

describe('review fixes', { timeout: 20_000 }, () => {
  const { password: _secret, ...saved } = ses;

  async function savedAndTested() {
    expect((await put(ses)).status).toBe(200);
    expect(await (await test({})).json()).toEqual({ result: 'ok' });
    h.createSmtpTransport.mockClear();
  }

  it('PUT: pointing the saved password at another host, provider or user needs it typed again', async () => {
    await savedAndTested();
    const host = await put({ ...saved, provider: 'custom', host: 'smtp.attacker.example' });
    expect(host.status).toBe(400);
    expect(await host.json()).toEqual({ error: 'password_required' });
    expect(await (await put({ ...saved, username: 'someone-else' })).json()).toEqual({ error: 'password_required' });
    expect(await (await put({ ...saved, region: 'us-east-1', host: 'email-smtp.us-east-1.amazonaws.com' })).json()).toEqual({ error: 'password_required' });
    // With the password typed again, or cleared, the move is fine; port and security alone need nothing.
    expect((await put({ ...saved, provider: 'custom', host: 'smtp.other.example', password: 'a-new-password-value' })).status).toBe(200);
    expect((await put({ ...saved, provider: 'custom', host: 'smtp.other.example', port: 2587 })).status).toBe(200);
  });

  it('PUT: an environment password never follows a host chosen on this screen (409 locked_by_env password)', async () => {
    vi.stubEnv('LOBBYFORGE_SMTP_PASSWORD', 'the-env-password');
    resetMailSettingsCacheForTests();
    const { password: _p, ...withoutPassword } = ses;
    // Not even the first host: with the password in the environment, the host goes there too.
    expect(await (await put(withoutPassword)).json()).toEqual({ error: 'locked_by_env', field: 'password' });
    vi.stubEnv('LOBBYFORGE_SMTP_HOST', ses.host);
    vi.stubEnv('LOBBYFORGE_SMTP_USER', ses.username);
    resetMailSettingsCacheForTests();
    expect((await put({ ...withoutPassword, provider: 'custom' })).status).toBe(200);
    expect((await put({ ...withoutPassword, provider: 'custom', port: 2587 })).status).toBe(200);
  });

  it('PUT: parking the transport on none and coming back still needs the password', async () => {
    await savedAndTested();
    expect((await put({ ...base })).status).toBe(200);
    expect(await (await put({ ...saved, provider: 'custom', host: 'smtp.attacker.example' })).json()).toEqual({ error: 'password_required' });
  });

  it('test: another connection never gets the saved password — it must come with the request', async () => {
    await savedAndTested();
    const res = await test({ host: 'smtp.attacker.example' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'password_required' });
    expect(h.createSmtpTransport).not.toHaveBeenCalled();
    for (const override of [{ provider: 'custom', host: 'email-smtp.eu-central-1.amazonaws.com' }, { port: 2587 }, { security: 'tls', port: 465 }, { username: 'other' }]) {
      expect(await (await test(override)).json()).toEqual({ error: 'password_required' });
    }
    // Typed: used as given (never the stored one); null = no authentication.
    expect(await (await test({ host: 'smtp.other.example', password: 'typed-password' })).json()).toEqual({ result: 'ok' });
    expect(h.createSmtpTransport.mock.calls.at(-1)![0]).toMatchObject({ host: 'smtp.other.example', password: 'typed-password' });
    expect(await (await test({ host: 'smtp.other.example', username: null })).json()).toEqual({ result: 'ok' });
    expect(h.createSmtpTransport.mock.calls.at(-1)![0]).toMatchObject({ username: null, password: null });
    // The saved connection (with another From or recipient) still uses the saved password.
    expect(await (await test({ to: 'x@example.org', from: 'Other <other@lobbyforge.example>' })).json()).toEqual({ result: 'ok' });
    expect(h.createSmtpTransport.mock.calls.at(-1)![0]).toMatchObject({ password: ses.password });
  });

  it('test: overriding an environment-locked field is 409 locked_by_env', async () => {
    vi.stubEnv('LOBBYFORGE_SMTP_HOST', 'smtp.relay.example');
    vi.stubEnv('LOBBYFORGE_SMTP_PASSWORD', 'env-password');
    resetMailSettingsCacheForTests();
    expect(await (await test({ host: 'smtp.attacker.example' })).json()).toEqual({ error: 'locked_by_env', field: 'host' });
    expect(await (await test({ password: 'x' })).json()).toEqual({ error: 'locked_by_env', field: 'password' });
    expect((await test({ host: 'smtp.relay.example' })).status).toBe(200);
  });

  it('required: refuses to leave no working transport (provider none, an undecryptable password)', async () => {
    await savedAndTested();
    const required = { mode: 'required', scope: { open_register: true, invite_register: false }, existingDeadline: null };
    expect((await put({ ...saved, verification: required })).status).toBe(200);
    const none = await put({ ...base, verification: required });
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: 'transport_required' });
    // Turning required off and the transport off in one save is fine.
    expect((await put({ ...base, verification: { ...required, mode: 'optional' } })).status).toBe(200);
    // An env-locked required mode: no saving a configuration without a transport.
    vi.stubEnv('LOBBYFORGE_EMAIL_VERIFICATION', 'required');
    resetMailSettingsCacheForTests();
    expect(await (await put({ ...base, verification: required })).json()).toEqual({ error: 'transport_required' });
  });

  it('a test only unlocks required for the configuration it tested, even if a save landed meanwhile', async () => {
    expect((await put(ses)).status).toBe(200);
    // The test starts against the saved settings; a save changes them while it runs.
    let finishTest: () => void = () => undefined;
    h.verify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishTest = () => resolve({ ok: true });
        })
    );
    const running = test({});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await put({ ...saved, port: 2587 })).status).toBe(200);
    finishTest();
    expect(await (await running).json()).toEqual({ result: 'ok' });
    // Recorded — but for the old configuration, so required stays locked.
    expect(fake.db.state.settings.lastTestResult).toBe('ok');
    const required = { mode: 'required', scope: { open_register: true, invite_register: false }, existingDeadline: null };
    expect(await (await put({ ...saved, port: 2587, verification: required })).json()).toEqual({ error: 'test_required' });
    expect((await (await get()).json()).lastTest).toEqual({ at: null, result: null });
  });
});

describe('the development preset in a production build', { timeout: 20_000 }, () => {
  const mailpit = { ...base, provider: 'mailpit', host: 'mailpit', port: 1025, security: 'none', from: 'LobbyForge <no-reply@lobbyforge.test>' };

  it('saves mailpit:1025 (the compose service) and refuses what that environment cannot reach', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    // No Redis in tests: the counters stay in memory.
    vi.stubEnv('LOBBYFORGE_RATE_LIMIT_STORE', 'memory');
    resetMailSettingsCacheForTests();
    const saved = await put(mailpit);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ provider: 'mailpit', host: 'mailpit', port: 1025, security: 'none' });
    // Without a host the preset's own default is the compose service too.
    expect(await (await put({ ...mailpit, host: null, port: null, security: null })).json()).toMatchObject({ host: 'mailpit', port: 1025 });
    // The dev-host variant is refused there (loopback, port 19525).
    expect(await (await put({ ...mailpit, host: 'localhost', port: 19525 })).json()).toEqual({ error: 'host_not_allowed', detail: 'port_not_allowed' });
  });

  it('is never offered (nor saved) on the official hub', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    // No Redis in tests: the counters stay in memory.
    vi.stubEnv('LOBBYFORGE_RATE_LIMIT_STORE', 'memory');
    vi.stubEnv('LOBBYFORGE_DEPLOYMENT_MODE', 'official');
    resetMailSettingsCacheForTests();
    expect(await (await put(mailpit)).json()).toMatchObject({ error: 'invalid_settings', issues: [{ path: 'provider', message: 'not_offered' }] });
  });
});
