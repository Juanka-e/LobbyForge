/**
 * `emailStatusFor` (docs/EMAIL.md §4.3) is the one builder of the status
 * answer: the status route and the page-render read (`emailStatusForPage`)
 * must give the same object for the same account.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredMail, createFakeEmailDb } from './fake-db';

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeEmailDb> }));

vi.mock('@lobbyforge/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lobbyforge/db')>();
  const { createFakeEmailDb: create } = await import('./fake-db');
  fake.db = create();
  return { ...actual, ...fake.db.fns };
});
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/security-headers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security-headers')>()),
  withApiSecurity: (handler: unknown) => handler,
}));

import { resetCaptchaMemoryForTests } from '@/lib/captcha/store';
import { emailStatusForPage } from '@/lib/email-status-ssr';
import { buildGuestSessionCookie } from '@/lib/guest-session';
import { resetMailSettingsCacheForTests } from '../settings';
import { accountSubject, ACCOUNT_SEND_LIMITS, countHit } from '../limits';
import { emailStatusFor } from '../status';

const SECRET = 'r'.repeat(48);
const UID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

async function fromRoute(): Promise<Response> {
  const { GET } = await import('@/app/api/auth/email/status/route');
  const cookie = `lf_guest=${buildGuestSessionCookie({ gid: 'g_'.padEnd(34, 'd'), uid: UID, name: 'M' }, SECRET).raw}`;
  return GET(new Request('https://community.example/api/auth/email/status', { headers: { cookie } }), {});
}

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  for (const name of ['LOBBYFORGE_EMAIL_VERIFICATION', 'LOBBYFORGE_SMTP_HOST', 'LOBBYFORGE_MAIL_PROVIDER']) vi.stubEnv(name, '');
  fake.db.reset();
  fake.db.state.settings = configuredMail({ verificationMode: 'required', enforcedSince: new Date(Date.now() - 60_000) });
  resetMailSettingsCacheForTests();
  resetCaptchaMemoryForTests();
});

describe('emailStatusFor', { timeout: 20_000 }, () => {
  it('the route and the page read answer the same object', async () => {
    fake.db.addUser({ id: UID, email: 'member@example.org' });
    await countHit(ACCOUNT_SEND_LIMITS, accountSubject(UID));
    fake.db.tokens.push({
      id: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0',
      userId: UID,
      purpose: 'change',
      targetEmail: 'new@example.org',
      tokenHash: Buffer.alloc(32, 2),
      codeHash: Buffer.alloc(32, 3),
      codeAttempts: 0,
      expiresAt: new Date(Date.now() + 3_600_000),
      codeExpiresAt: new Date(Date.now() + 600_000),
      consumedAt: null,
      createdAt: new Date(),
    });

    const direct = await emailStatusFor(UID);
    expect(direct).toMatchObject({
      email: 'member@example.org',
      verified: false,
      mode: 'required',
      restricted: true,
      pendingChange: 'new@example.org',
      mailConfigured: true,
    });
    expect(Object.keys(direct!).sort()).toEqual(['email', 'mailConfigured', 'mode', 'pendingChange', 'resendAvailableAt', 'restricted', 'verified']);
    expect(Date.parse(direct!.resendAvailableAt!)).toBeGreaterThan(Date.now());

    const route = await (await fromRoute()).json();
    const page = await emailStatusForPage(UID);
    // resendAvailableAt is "now + wait", read a few ms apart: everything else must be equal.
    const rest = ({ resendAvailableAt: _r, ...others }: Record<string, unknown>) => others;
    expect(rest(route)).toEqual(rest(direct as unknown as Record<string, unknown>));
    expect(rest(page as unknown as Record<string, unknown>)).toEqual(rest(direct as unknown as Record<string, unknown>));
    for (const other of [route.resendAvailableAt as string, page!.resendAvailableAt!]) {
      expect(Math.abs(Date.parse(other) - Date.parse(direct!.resendAvailableAt!))).toBeLessThan(2_000);
    }
  });

  it('a missing or deleted account: null (the route answers 401); the page shows nothing to guests', async () => {
    expect(await emailStatusFor(UID)).toBeNull();
    expect((await fromRoute()).status).toBe(401);
    expect(await emailStatusForPage(UID)).toBeNull();
    expect(await emailStatusForPage(null)).toBeNull();

    fake.db.addUser({ id: UID, email: null, isGuest: true, emailVerifiedAt: new Date() });
    expect(await emailStatusFor(UID)).toMatchObject({ email: null, verified: true, pendingChange: null, restricted: false });
    expect(await emailStatusForPage(UID)).toBeNull();
  });

  it('the page read never throws: undefined when it cannot tell', async () => {
    fake.db.addUser({ id: UID, email: 'member@example.org' });
    fake.db.state.settingsUnreadable = true;
    resetMailSettingsCacheForTests();
    // Unreadable settings are not an error (defaults apply)…
    expect(await emailStatusForPage(UID)).toMatchObject({ mode: 'off', mailConfigured: false });
    // …an unreadable account is.
    fake.db.state.userReadsFail = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await emailStatusForPage(UID)).toBeUndefined();
    expect(errors.mock.calls.flat().join(' ')).not.toContain('member@example.org');
    errors.mockRestore();
  });
});
