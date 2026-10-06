/**
 * The user-side email API (docs/EMAIL.md §4.3): status, verification send
 * and confirm (code with a session, link token without), email change and
 * its confirmation. Rate limits (§4.4) where they answer; the consumption
 * race (double submit) on the same challenge.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeEmailDb, configuredMail } from '@/lib/mail/__tests__/fake-db';

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeEmailDb> }));
const h = vi.hoisted(() => ({ dispatchMail: vi.fn(), revokeOtherSessions: vi.fn() }));

vi.mock('@lobbyforge/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lobbyforge/db')>();
  const { createFakeEmailDb: create } = await import('@/lib/mail/__tests__/fake-db');
  fake.db = create();
  return { ...actual, ...fake.db.fns };
});
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/security-headers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security-headers')>()),
  withApiSecurity: (handler: unknown) => handler,
}));
vi.mock('@/lib/mail/send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mail/send')>()),
  dispatchMail: h.dispatchMail,
}));
vi.mock('@/lib/session-tracker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session-tracker')>()),
  revokeOtherSessions: h.revokeOtherSessions,
}));

import { resetAccountAttemptsForTests } from '@/lib/auth-throttle';
import { resetCaptchaMemoryForTests } from '@/lib/captcha/store';
import { buildGuestSessionCookie } from '@/lib/guest-session';
import { resetMailSettingsCacheForTests } from '@/lib/mail/settings';
import { hashPassword } from '@/lib/password';

const SECRET = 'e'.repeat(48);
const UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GID = 'g_'.padEnd(34, 'c');
const PASSWORD = 'correct horse battery';
let passwordHash = '';

function cookie(uid = UID): string {
  return `lf_guest=${buildGuestSessionCookie({ gid: GID, uid, name: 'Member' }, SECRET).raw}`;
}

function req(path: string, init: { method?: string; body?: unknown; signedIn?: boolean; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers ?? {}) };
  if (init.signedIn !== false && !headers.cookie) headers.cookie = cookie();
  return new Request(`https://community.example${path}`, {
    method: init.method ?? 'POST',
    headers,
    ...(init.method === 'GET' ? {} : { body: JSON.stringify(init.body ?? {}) }),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const routes = {
  status: async () => (await import('../status/route')).GET(req('/api/auth/email/status', { method: 'GET' }), {}),
  send: async (init: Parameters<typeof req>[1] = {}) => (await import('../verify/send/route')).POST(req('/api/auth/email/verify/send', init), {}),
  verify: async (body: unknown, init: Parameters<typeof req>[1] = {}) => (await import('../verify/route')).POST(req('/api/auth/email/verify', { ...init, body }), {}),
  change: async (body: unknown) => (await import('../change/route')).POST(req('/api/auth/email/change', { body }), {}),
  confirm: async (body: unknown, init: Parameters<typeof req>[1] = {}) => (await import('../change/confirm/route')).POST(req('/api/auth/email/change/confirm', { ...init, body }), {}),
};

/** The vars of the last email sent with this template. */
function lastMail(template: string) {
  const call = [...h.dispatchMail.mock.calls].reverse().find(([input]) => input.template === template);
  return call?.[0] as { to: string; template: string; locale: string; vars: { code: string; link: string | null } } | undefined;
}

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  vi.stubEnv('LOBBYFORGE_APP_ORIGIN', 'https://chat.example.org');
  for (const name of ['LOBBYFORGE_EMAIL_VERIFICATION', 'LOBBYFORGE_SMTP_HOST', 'LOBBYFORGE_MAIL_PROVIDER', 'LOBBYFORGE_MAIL_FROM', 'LOBBYFORGE_TRUSTED_PROXY']) vi.stubEnv(name, '');
  fake.db.reset();
  fake.db.state.settings = configuredMail({ verificationMode: 'optional' });
  fake.db.addUser({ id: UID, email: 'member@example.org', passwordHash });
  h.dispatchMail.mockReset();
  h.revokeOtherSessions.mockReset().mockResolvedValue(0);
  resetMailSettingsCacheForTests();
  resetCaptchaMemoryForTests();
  resetAccountAttemptsForTests();
});

describe('GET /api/auth/email/status', { timeout: 20_000 }, () => {
  it('answers the contract shape', async () => {
    const res = await routes.status();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      email: 'member@example.org',
      verified: false,
      mode: 'optional',
      restricted: false,
      pendingChange: null,
      resendAvailableAt: null,
      mailConfigured: true,
    });
  });

  it('reports restriction in required mode, the resend cooldown, and no transport', async () => {
    fake.db.state.settings = configuredMail({ verificationMode: 'required', enforcedSince: new Date(Date.now() - 60_000) });
    resetMailSettingsCacheForTests();
    await routes.send();
    const body = await json(await routes.status());
    expect(body).toMatchObject({ mode: 'required', restricted: true });
    expect(Date.parse(body.resendAvailableAt as string)).toBeGreaterThan(Date.now());

    fake.db.state.settings = { ...configuredMail(), provider: 'none' };
    resetMailSettingsCacheForTests();
    expect(await json(await routes.status())).toMatchObject({ mailConfigured: false, mode: 'off', restricted: false });
  });

  it('needs a session', async () => {
    const res = await (await import('../status/route')).GET(req('/api/auth/email/status', { method: 'GET', signedIn: false }), {});
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/email/verify/send', { timeout: 20_000 }, () => {
  it('202 with resendAvailableAt; the email carries a code and a link from the configured origin', async () => {
    const res = await routes.send({ headers: { cookie: `${cookie()}; lf_locale=tr` } });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.sent).toBe(true);
    expect(Date.parse(body.resendAvailableAt as string) - Date.now()).toBeGreaterThan(50_000);
    const mail = lastMail('verify')!;
    expect(mail).toMatchObject({ to: 'member@example.org', locale: 'tr' });
    expect(mail.vars.code).toMatch(/^\d{6}$/);
    expect(mail.vars.link).toMatch(/^https:\/\/chat\.example\.org\/verify-email\?t=[A-Za-z0-9_-]{43}$/);
  });

  it('60 s cooldown → 429 rate_limited with retryAfter', async () => {
    expect((await routes.send()).status).toBe(202);
    const again = await routes.send();
    expect(again.status).toBe(429);
    const body = await json(again);
    expect(body.error).toBe('rate_limited');
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('409 already_verified, 400 no_email for a guest, 503 mail_unavailable / mail_quota', async () => {
    fake.db.users.get(UID)!.emailVerifiedAt = new Date();
    expect(await json(await routes.send())).toEqual({ error: 'already_verified' });
    fake.db.users.get(UID)!.emailVerifiedAt = null;

    fake.db.users.get(UID)!.isGuest = true;
    fake.db.users.get(UID)!.email = null;
    expect((await routes.send()).status).toBe(400);
    fake.db.users.get(UID)!.isGuest = false;
    fake.db.users.get(UID)!.email = 'member@example.org';

    fake.db.state.settings = { ...configuredMail(), provider: 'none' };
    resetMailSettingsCacheForTests();
    const off = await routes.send();
    expect(off.status).toBe(503);
    expect(await json(off)).toEqual({ error: 'mail_unavailable' });
    expect(h.dispatchMail).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/email/verify', { timeout: 20_000 }, () => {
  it('the code (with the session) verifies the account', async () => {
    await routes.send();
    const { code } = lastMail('verify')!.vars;
    const res = await routes.verify({ code });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ verified: true });
    expect(fake.db.users.get(UID)!.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('wrong codes: invalid_code, then too_many_attempts on the fifth; the link still works', async () => {
    await routes.send();
    const { code, link } = lastMail('verify')!.vars;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i += 1) expect(await json(await routes.verify({ code: wrong }))).toEqual({ error: 'invalid_code' });
    expect(await json(await routes.verify({ code: wrong }))).toEqual({ error: 'too_many_attempts' });
    expect(await json(await routes.verify({ code }))).toEqual({ error: 'too_many_attempts' });
    const token = new URL(link!).searchParams.get('t')!;
    expect(await json(await routes.verify({ token }, { signedIn: false }))).toEqual({ verified: true });
  });

  it('the link token needs no session, never signs in, and is single use', async () => {
    await routes.send();
    const token = new URL(lastMail('verify')!.vars.link!).searchParams.get('t')!;
    const res = await routes.verify({ token }, { signedIn: false });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await json(await routes.verify({ token }, { signedIn: false }))).toEqual({ error: 'invalid_token' });
    expect(await json(await routes.verify({ token: 'A'.repeat(43) }, { signedIn: false }))).toEqual({ error: 'invalid_token' });
  });

  it('an expired code answers expired; a new send invalidates the previous code', async () => {
    await routes.send();
    const first = lastMail('verify')!.vars.code;
    fake.db.tokens[0]!.codeExpiresAt = new Date(Date.now() - 1);
    expect(await json(await routes.verify({ code: first }))).toEqual({ error: 'expired' });
    // Past the cooldown, a new send replaces the challenge.
    resetCaptchaMemoryForTests();
    await routes.send();
    const second = lastMail('verify')!.vars.code;
    if (second !== first) expect(await json(await routes.verify({ code: first }))).toEqual({ error: 'invalid_code' });
    expect(await json(await routes.verify({ code: second }))).toEqual({ verified: true });
  });

  it('a double submit of the same link: exactly one consumes it', async () => {
    await routes.send();
    const token = new URL(lastMail('verify')!.vars.link!).searchParams.get('t')!;
    // Both requests look the token up before either consumes: the conditional UPDATE decides.
    const results = await Promise.all([routes.verify({ token }, { signedIn: false }), routes.verify({ token }, { signedIn: false })]);
    const bodies = await Promise.all(results.map(json));
    expect(bodies).toContainEqual({ verified: true });
    expect(bodies).toContainEqual({ error: 'invalid_token' });
    expect(fake.db.tokens.filter((t) => t.consumedAt)).toHaveLength(1);
  });

  it('10 code attempts per account per 15 minutes → 429', async () => {
    await routes.send();
    for (let i = 0; i < 10; i += 1) await routes.verify({ code: '999999' });
    const res = await routes.verify({ code: '999999' });
    expect(res.status).toBe(429);
    expect((await json(res)).error).toBe('rate_limited');
  });

  it('a code needs the session; a malformed body is refused', async () => {
    expect((await routes.verify({ code: '123456' }, { signedIn: false })).status).toBe(401);
    expect((await routes.verify({ code: '12345' })).status).toBe(400);
    expect((await routes.verify({ code: '123456', token: 'x' })).status).toBe(400);
  });
});

describe('email change', { timeout: 20_000 }, () => {
  it('checks the password, the address and that it is free', async () => {
    expect(await json(await routes.change({ newEmail: 'new@example.org', currentPassword: 'wrong password!' }))).toEqual({ error: 'invalid_password' });
    expect(await json(await routes.change({ newEmail: 'not-an-email', currentPassword: PASSWORD }))).toEqual({ error: 'invalid_email' });
    expect(await json(await routes.change({ newEmail: 'member@example.org', currentPassword: PASSWORD }))).toEqual({ error: 'invalid_email' });
    fake.db.addUser({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'taken@example.org' });
    const taken = await routes.change({ newEmail: 'Taken@Example.org', currentPassword: PASSWORD });
    expect(taken.status).toBe(409);
    expect(await json(taken)).toEqual({ error: 'email_taken' });
  });

  it('refuses a disposable address when the block is on (admin allow wins)', async () => {
    fake.db.state.settings = configuredMail({ verificationMode: 'optional', disposableBlock: true, disposableOverrides: { allow: ['yopmail.com'], block: [] } });
    resetMailSettingsCacheForTests();
    expect(await json(await routes.change({ newEmail: 'me@mailinator.com', currentPassword: PASSWORD }))).toEqual({ error: 'disposable_email' });
    expect((await routes.change({ newEmail: 'me@yopmail.com', currentPassword: PASSWORD })).status).toBe(202);
  });

  it('off mode without a transport changes the address at once (unverified)', async () => {
    fake.db.state.settings = { ...configuredMail(), provider: 'none' };
    fake.db.users.get(UID)!.emailVerifiedAt = new Date();
    resetMailSettingsCacheForTests();
    const res = await routes.change({ newEmail: 'direct@example.org', currentPassword: PASSWORD });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ changed: true });
    expect(fake.db.users.get(UID)).toMatchObject({ email: 'direct@example.org', emailVerifiedAt: null });
  });

  it('otherwise: 202 pending, change-confirm to the NEW address; the code applies it, notifies the old one and revokes other sessions', async () => {
    const res = await routes.change({ newEmail: 'new@example.org', currentPassword: PASSWORD });
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ pending: true });
    expect(fake.db.users.get(UID)!.email).toBe('member@example.org');
    const mail = lastMail('change-confirm')!;
    expect(mail.to).toBe('new@example.org');
    expect(await json(await routes.status())).toMatchObject({ pendingChange: 'new@example.org' });

    const confirmed = await routes.confirm({ code: mail.vars.code });
    expect(confirmed.status).toBe(200);
    expect(await json(confirmed)).toEqual({ changed: true, email: 'new@example.org' });
    expect(fake.db.users.get(UID)).toMatchObject({ email: 'new@example.org' });
    expect(fake.db.users.get(UID)!.emailVerifiedAt).toBeInstanceOf(Date);
    const notice = lastMail('change-notice')!;
    expect(notice.to).toBe('member@example.org');
    expect(notice.vars).toMatchObject({ email: 'n***@example.org' });
    expect(h.revokeOtherSessions).toHaveBeenCalledWith(UID, GID);
  });

  it('the link confirms from anywhere (also through the /verify-email endpoint); taken meanwhile → 409', async () => {
    await routes.change({ newEmail: 'new@example.org', currentPassword: PASSWORD });
    const token = new URL(lastMail('change-confirm')!.vars.link!).searchParams.get('t')!;
    fake.db.addUser({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'new@example.org' });
    const taken = await routes.confirm({ token }, { signedIn: false });
    expect(taken.status).toBe(409);
    expect(await json(taken)).toEqual({ error: 'email_taken' });
    fake.db.users.delete('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    const viaVerify = await routes.verify({ token }, { signedIn: false });
    expect(await json(viaVerify)).toEqual({ verified: true, changed: true });
    // Signed out everywhere: the confirmation did not come from the account's own session.
    expect(h.revokeOtherSessions).toHaveBeenCalledWith(UID, '');
  });
});

describe('review fixes', { timeout: 20_000 }, () => {
  it('a burst of concurrent sends: exactly one email, the rest 429 (the limits count atomically)', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => routes.send()));
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
    expect(h.dispatchMail).toHaveBeenCalledTimes(1);
  });

  it('a burst of concurrent change requests: exactly one email', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => routes.change({ newEmail: 'burst-new@example.org', currentPassword: PASSWORD })));
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(h.dispatchMail).toHaveBeenCalledTimes(1);
  });

  it('a burst of concurrent wrong codes: never more than 5 compared, then the code is dead', async () => {
    await routes.send();
    const { code } = lastMail('verify')!.vars;
    const wrong = code === '000000' ? '111111' : '000000';
    const bodies = await Promise.all(Array.from({ length: 9 }, () => routes.verify({ code: wrong }).then(json)));
    expect(bodies.every((b) => b.error === 'invalid_code' || b.error === 'too_many_attempts')).toBe(true);
    expect(fake.db.tokens.find((t) => t.purpose === 'verify')!.codeAttempts).toBe(5);
    expect(await json(await routes.verify({ code }))).toEqual({ error: 'too_many_attempts' });
  });

  it('a direct change (off mode, no transport) also revokes the other sessions', async () => {
    fake.db.state.settings = { ...configuredMail(), provider: 'none' };
    resetMailSettingsCacheForTests();
    expect((await routes.change({ newEmail: 'direct2@example.org', currentPassword: PASSWORD })).status).toBe(200);
    expect(h.revokeOtherSessions).toHaveBeenCalledWith(UID, GID);
  });

  it('confirming a change drops the verification sent to the old address', async () => {
    await routes.send();
    const verifyToken = new URL(lastMail('verify')!.vars.link!).searchParams.get('t')!;
    resetCaptchaMemoryForTests();
    await routes.change({ newEmail: 'moved@example.org', currentPassword: PASSWORD });
    await routes.confirm({ code: lastMail('change-confirm')!.vars.code });
    expect(await json(await routes.verify({ token: verifyToken }, { signedIn: false }))).toEqual({ error: 'invalid_token' });
  });
});

describe('change after sign-up', { timeout: 20_000 }, () => {
  it('fixing a typo right after the verification email is not blocked by its cooldown; a second change is', async () => {
    expect((await routes.send()).status).toBe(202);
    const change = await routes.change({ newEmail: 'fixed@example.org', currentPassword: PASSWORD });
    expect(change.status).toBe(202);
    expect(lastMail('change-confirm')!.to).toBe('fixed@example.org');
    const again = await routes.change({ newEmail: 'fixed-again@example.org', currentPassword: PASSWORD });
    expect(again.status).toBe(429);
    expect((await json(again)).error).toBe('rate_limited');
    // And the verification resend keeps its own cooldown.
    expect((await routes.send()).status).toBe(429);
  });
});
