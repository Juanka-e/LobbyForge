/**
 * Password reset (docs/EMAIL.md §4.3):
 *   - forgot: the CAPTCHA surface `password_reset` first; the same 202 body
 *     for known and unknown addresses (the email only for a real account);
 *     the 3/hour per-address cap stays silent; no transport → 503;
 *   - reset: by link or by email + code; the sign-up password policy; every
 *     session revoked (no session kept) and handoff codes dropped; the
 *     address verified; single use (a double submit consumes once).
 */
import { NextResponse } from 'next/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredMail, createFakeEmailDb } from '@/lib/mail/__tests__/fake-db';

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeEmailDb> }));
const h = vi.hoisted(() => ({
  dispatchMail: vi.fn(),
  revokeOtherSessions: vi.fn(),
  revokeDesktopHandoffCodes: vi.fn(),
  guardCaptchaSurface: vi.fn(),
}));

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
vi.mock('@/lib/desktop-handoff-codes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/desktop-handoff-codes')>()),
  revokeDesktopHandoffCodes: h.revokeDesktopHandoffCodes,
}));
vi.mock('@/lib/captcha/guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/captcha/guard')>()),
  guardCaptchaSurface: h.guardCaptchaSurface,
}));

import { resetAccountAttemptsForTests } from '@/lib/auth-throttle';
import { DEFAULT_CAPTCHA_SURFACES } from '@/lib/captcha/types';
import { resetCaptchaMemoryForTests } from '@/lib/captcha/store';
import { resetMailSettingsCacheForTests } from '@/lib/mail/settings';
import { hashPassword, verifyPassword } from '@/lib/password';

const UID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const EMAIL = 'owner.of.account@example.org';
let oldHash = '';

function post(path: string, body: unknown): Request {
  return new Request(`https://community.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const forgot = async (body: unknown) => (await import('../forgot/route')).POST(post('/api/auth/password/forgot', body), {});
const reset = async (body: unknown) => (await import('../reset/route')).POST(post('/api/auth/password/reset', body), {});
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function lastReset() {
  const call = [...h.dispatchMail.mock.calls].reverse().find(([input]) => input.template === 'reset');
  return call?.[0] as { to: string; vars: { code: string; link: string | null; linkHours: number } } | undefined;
}

beforeAll(async () => {
  oldHash = await hashPassword('the old password!');
});

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'f'.repeat(48));
  vi.stubEnv('LOBBYFORGE_APP_ORIGIN', 'https://chat.example.org');
  for (const name of ['LOBBYFORGE_EMAIL_VERIFICATION', 'LOBBYFORGE_SMTP_HOST', 'LOBBYFORGE_MAIL_PROVIDER', 'LOBBYFORGE_TRUSTED_PROXY']) vi.stubEnv(name, '');
  fake.db.reset();
  fake.db.state.settings = configuredMail();
  fake.db.addUser({ id: UID, email: EMAIL, passwordHash: oldHash });
  h.dispatchMail.mockReset();
  h.revokeOtherSessions.mockReset().mockResolvedValue(2);
  h.revokeDesktopHandoffCodes.mockReset().mockResolvedValue(0);
  h.guardCaptchaSurface.mockReset().mockResolvedValue(null);
  resetMailSettingsCacheForTests();
  resetCaptchaMemoryForTests();
  resetAccountAttemptsForTests();
});

describe('POST /api/auth/password/forgot', { timeout: 20_000 }, () => {
  it('password_reset is a CAPTCHA surface, on by default, checked before anything is sent', async () => {
    expect(DEFAULT_CAPTCHA_SURFACES.password_reset).toBe('on');
    h.guardCaptchaSurface.mockResolvedValue(NextResponse.json({ error: 'captcha_required' }, { status: 400 }));
    const res = await forgot({ email: EMAIL });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'captcha_required' });
    expect(h.guardCaptchaSurface).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ email: EMAIL }), 'password_reset');
    await flush();
    expect(h.dispatchMail).not.toHaveBeenCalled();
  });

  it('answers a known and an unknown address identically; only the account gets an email', async () => {
    const known = await forgot({ email: EMAIL.toUpperCase(), captchaToken: 't', formToken: 'f', website: '' });
    const unknown = await forgot({ email: 'nobody.here@example.org', captchaToken: 't', formToken: 'f', website: '' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.json()).toEqual({ sent: true });
    expect(await unknown.json()).toEqual({ sent: true });
    expect([...known.headers.keys()].sort()).toEqual([...unknown.headers.keys()].sort());
    await flush();
    expect(h.dispatchMail).toHaveBeenCalledTimes(1);
    const mail = lastReset()!;
    expect(mail.to).toBe(EMAIL);
    expect(mail.vars.link).toMatch(/^https:\/\/chat\.example\.org\/reset-password\?t=/);
    expect(mail.vars.linkHours).toBe(1);
  });

  it('a guest or deleted account gets nothing, with the same answer', async () => {
    fake.db.users.get(UID)!.deletedAt = new Date();
    expect((await forgot({ email: EMAIL })).status).toBe(202);
    await flush();
    expect(h.dispatchMail).not.toHaveBeenCalled();
  });

  it('3 per hour per target address, silently', async () => {
    vi.stubEnv('LOBBYFORGE_TRUSTED_PROXY', 'x-forwarded-for');
    for (let i = 0; i < 5; i += 1) {
      const res = await (await import('../forgot/route')).POST(
        new Request('https://community.example/api/auth/password/forgot', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i + 1}` },
          body: JSON.stringify({ email: EMAIL }),
        }),
        {}
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ sent: true });
      await flush();
    }
    expect(h.dispatchMail).toHaveBeenCalledTimes(3);
  });

  it('without a transport: 503 mail_unavailable (instance-wide, before the challenge); a bad address: 400', async () => {
    fake.db.state.settings = { ...configuredMail(), provider: 'none' };
    resetMailSettingsCacheForTests();
    const res = await forgot({ email: EMAIL });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'mail_unavailable' });
    expect(h.guardCaptchaSurface).not.toHaveBeenCalled();
    expect((await forgot({ email: 'nope' })).status).toBe(400);
    expect((await forgot({ email: EMAIL, extra: 1 })).status).toBe(400);
  });
});

describe('POST /api/auth/password/reset', { timeout: 20_000 }, () => {
  async function requestReset(): Promise<{ token: string; code: string }> {
    await forgot({ email: EMAIL });
    await flush();
    const mail = lastReset()!;
    return { token: new URL(mail.vars.link!).searchParams.get('t')!, code: mail.vars.code };
  }

  it('by link: sets the password, verifies the address, revokes EVERY session and the handoff codes', async () => {
    const { token } = await requestReset();
    const res = await reset({ token, newPassword: 'a brand new password' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reset: true });
    expect(res.headers.get('set-cookie')).toBeNull();
    const user = fake.db.users.get(UID)!;
    expect(await verifyPassword('a brand new password', user.passwordHash!)).toBe(true);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(h.revokeOtherSessions).toHaveBeenCalledWith(UID, '');
    expect(h.revokeDesktopHandoffCodes).toHaveBeenCalledWith(UID);
    // Single use.
    expect(await (await reset({ token, newPassword: 'yet another password' })).json()).toEqual({ error: 'invalid_token' });
  });

  it('by email + code; wrong code; the sign-up password policy', async () => {
    const { code } = await requestReset();
    expect(await (await reset({ email: EMAIL, code, newPassword: 'short' })).json()).toEqual({ error: 'weak_password' });
    const wrong = code === '000000' ? '111111' : '000000';
    expect(await (await reset({ email: EMAIL, code: wrong, newPassword: 'a brand new password' })).json()).toEqual({ error: 'invalid_code' });
    expect(await (await reset({ email: 'nobody@example.org', code, newPassword: 'a brand new password' })).json()).toEqual({ error: 'invalid_code' });
    const ok = await reset({ email: EMAIL.toUpperCase(), code, newPassword: 'a brand new password' });
    expect(ok.status).toBe(200);
    expect(await verifyPassword('a brand new password', fake.db.users.get(UID)!.passwordHash!)).toBe(true);
  });

  it('a double submit of one link consumes it once', async () => {
    const { token } = await requestReset();
    const results = await Promise.all([reset({ token, newPassword: 'first new password!' }), reset({ token, newPassword: 'second new password' })]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(bodies).toContainEqual({ reset: true });
    expect(bodies).toContainEqual({ error: 'invalid_token' });
    expect(fake.db.tokens.filter((t) => t.consumedAt)).toHaveLength(1);
  });

  it('an expired link answers expired; a revocation failure still reports success with a warning', async () => {
    const first = await requestReset();
    fake.db.tokens.find((t) => !t.consumedAt)!.expiresAt = new Date(Date.now() - 1);
    expect(await (await reset({ token: first.token, newPassword: 'a brand new password' })).json()).toEqual({ error: 'expired' });
    resetCaptchaMemoryForTests();
    const second = await requestReset();
    h.revokeOtherSessions.mockRejectedValue(new Error('redis down'));
    expect(await (await reset({ token: second.token, newPassword: 'a brand new password' })).json()).toEqual({ reset: true, warning: 'sessions_not_revoked' });
  });
});

describe('review fixes', { timeout: 20_000 }, () => {
  async function requestReset(): Promise<{ token: string; code: string }> {
    await forgot({ email: EMAIL });
    await flush();
    const mail = lastReset()!;
    return { token: new URL(mail.vars.link!).searchParams.get('t')!, code: mail.vars.code };
  }

  it('BLOCKER: a pending email change does not survive the reset (its token is then invalid_token)', async () => {
    // The attacker, who knew the password, started a change to their own address.
    const { hashLinkToken, issueChallenge } = await import('@/lib/mail/tokens');
    const change = await issueChallenge({ userId: UID, purpose: 'change', targetEmail: 'attacker@example.org' });
    // The victim resets the password.
    const { token } = await requestReset();
    expect((await reset({ token, newPassword: 'the victim takes it back' })).status).toBe(200);
    expect(fake.db.tokens.some((t) => t.tokenHash.equals(hashLinkToken(change.token)!))).toBe(false);
    const confirm = await (await import('../../email/change/confirm/route')).POST(
      new Request('https://community.example/api/auth/email/change/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: change.token }),
      }),
      {}
    );
    expect(await confirm.json()).toEqual({ error: 'invalid_token' });
    expect(fake.db.users.get(UID)!.email).toBe(EMAIL);
  });

  it('by code, every failure is the same invalid_code: wrong, expired, used up, unknown account, moved address', async () => {
    const { code } = await requestReset();
    const wrong = code === '000000' ? '111111' : '000000';
    const body = (newPassword = 'a brand new password') => ({ email: EMAIL, code: wrong, newPassword });
    expect(await (await reset(body())).json()).toEqual({ error: 'invalid_code' });
    expect(await (await reset({ email: 'nobody@example.org', code, newPassword: 'a brand new password' })).json()).toEqual({ error: 'invalid_code' });
    // Used up: the fifth wrong attempt, then even the right code.
    for (let i = 0; i < 4; i += 1) expect(await (await reset(body())).json()).toEqual({ error: 'invalid_code' });
    expect(await (await reset({ email: EMAIL, code, newPassword: 'a brand new password' })).json()).toEqual({ error: 'invalid_code' });
    // Expired.
    resetCaptchaMemoryForTests();
    const second = await requestReset();
    fake.db.tokens.find((t) => !t.consumedAt && t.purpose === 'reset')!.codeExpiresAt = new Date(Date.now() - 1);
    expect(await (await reset({ email: EMAIL, code: second.code, newPassword: 'a brand new password' })).json()).toEqual({ error: 'invalid_code' });
    // The address changed since the code was sent.
    resetCaptchaMemoryForTests();
    const third = await requestReset();
    fake.db.users.get(UID)!.email = 'moved@example.org';
    const moved = await reset({ email: 'moved@example.org', code: third.code, newPassword: 'a brand new password' });
    expect(await moved.json()).toEqual({ error: 'invalid_code' });
  });

  it('reset codes have their own attempt budget, keyed by the address typed — known or not', async () => {
    // RESET_CODE_ATTEMPTS: 10 per 15 minutes.
    for (let i = 0; i < 10; i += 1) await reset({ email: 'unknown@example.org', code: '000000', newPassword: 'a brand new password' });
    const limited = await reset({ email: 'unknown@example.org', code: '000000', newPassword: 'a brand new password' });
    expect(limited.status).toBe(429);
    // Another address is untouched, and verify/change attempts never shared it.
    expect((await reset({ email: EMAIL, code: '000000', newPassword: 'a brand new password' })).status).toBe(400);
  });
});
