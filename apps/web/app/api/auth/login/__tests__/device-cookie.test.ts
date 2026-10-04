import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security follow-up: device cookies (OWASP "Slow Down Online Guessing
 * Attacks with Device Cookies") on POST /api/auth/login and
 * POST /api/auth/desktop-session (start). The per-account limit alone let
 * anyone who knows an address lock its owner out; a browser that signed
 * in to the account before now has its own bucket and is not refused by
 * the account-wide lock. Everything else about the limit stays. Each entry
 * is bound to the password hash it was issued under, so a password change
 * takes that bucket away from every browser that had one.
 */

const { getUserCredentialsByEmail, verifyPassword, recordSession, storeDesktopHandoffCode } = vi.hoisted(() => ({
  getUserCredentialsByEmail: vi.fn(),
  verifyPassword: vi.fn(),
  recordSession: vi.fn(),
  storeDesktopHandoffCode: vi.fn(),
}));

vi.mock('@lobbyforge/db', () => ({ getUserCredentialsByEmail }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __test: true }) }));
vi.mock('@/lib/password', () => ({ DUMMY_PASSWORD_HASH: 'dummy-hash', verifyPassword }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  resolveClientAddress: () => '203.0.113.7',
}));
vi.mock('@/lib/session-tracker', () => ({ recordSession }));
// Bot protection is covered by lib/captcha/__tests__ — a pass-through here.
vi.mock('@/lib/captcha/guard', () => ({ guardSignInCaptcha: async () => null, noteSignInFailure: async () => undefined }));
vi.mock('@/lib/desktop-handoff-codes', () => ({
  DESKTOP_HANDOFF_TTL_SECONDS: 300,
  credentialFingerprint: () => 'fingerprint',
  storeDesktopHandoffCode,
}));

import { resetAccountAttemptsForTests } from '@/lib/auth-throttle';
import { signSessionCookie } from '@/lib/cookies';
import { buildDeviceCookie } from '@/lib/device-cookie';
import { readGuestSession } from '@/lib/guest-session';

const SECRET = 'x'.repeat(32);
const KNOWN = 'owner@example.com';
const SECOND = 'second@example.com';
const UNKNOWN = 'nobody@example.com';
const CORRECT = 'correct password';
const NEW_PASSWORD = 'brand new password';
const DAY = 24 * 60 * 60;

/** A stand-in password hash: `hash:<email>:<password>` (a real one also changes salt every time). */
function hashFor(email: string, password: string): string {
  return `hash:${email}:${password}`;
}

function userRow(email: string, id: string) {
  return { id, email, displayName: email.split('@')[0], passwordHash: hashFor(email, CORRECT), deletedAt: null };
}
let USERS: Record<string, ReturnType<typeof userRow>> = {};

/** What POST /api/auth/password does to the row: a new password hash. */
function changePassword(email: string, password: string): void {
  USERS[email] = { ...USERS[email], passwordHash: hashFor(email, password) };
}

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  resetAccountAttemptsForTests();
  USERS = {
    [KNOWN]: userRow(KNOWN, '00000000-0000-0000-0000-000000000001'),
    [SECOND]: userRow(SECOND, '00000000-0000-0000-0000-000000000002'),
  };
  getUserCredentialsByEmail.mockReset().mockImplementation(async (_db: unknown, email: string) => USERS[email] ?? null);
  verifyPassword.mockReset().mockImplementation(async (password: string, hash: string) =>
    hash.startsWith('hash:') && hash.endsWith(`:${password}`)
  );
  recordSession.mockReset().mockResolvedValue(undefined);
  storeDesktopHandoffCode.mockReset().mockResolvedValue(undefined);
});

function request(path: string, email: string, password: string, cookie?: string | null): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password }),
  });
}

async function login(email: string, password: string, cookie?: string | null): Promise<Response> {
  const { POST } = await import('../route.js');
  return POST(request('/api/auth/login', email, password, cookie), {});
}

async function desktopStart(email: string, password: string, cookie?: string | null): Promise<Response> {
  const { POST } = await import('../../desktop-session/route.js');
  return POST(request('/api/auth/desktop-session', email, password, cookie), {});
}

type Door = typeof login;
const DOORS: Array<[string, Door]> = [
  ['login', login],
  ['desktop-session start', desktopStart],
];

/** The `lf_device=…` header the response set, if any. */
function deviceSetCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith('lf_device='));
}

/** What the browser sends back for that cookie. */
function devicePair(res: Response): string {
  const header = deviceSetCookie(res);
  if (!header) throw new Error('expected an lf_device cookie');
  return header.split(';', 1)[0];
}

/** A browser that signed in to `email` once: its device cookie. */
async function knownDevice(email = KNOWN, door: Door = login, cookie?: string): Promise<string> {
  const res = await door(email, CORRECT, cookie);
  expect(res.status).toBe(200);
  return devicePair(res);
}

/** Lock the account-wide counter (from browsers without a device cookie). */
async function lockAccount(email = KNOWN): Promise<void> {
  for (let i = 0; i < 10; i += 1) expect((await login(email, 'wrong')).status).toBe(401);
  expect((await login(email, CORRECT)).status).toBe(429);
}

/** Status + body with the clock-dependent fields removed, and what was set. */
async function shape(res: Response) {
  const body = (await res.json()) as Record<string, unknown>;
  delete body.resetAt;
  delete body.retryAfter;
  return {
    status: res.status,
    body,
    retryAfter: res.headers.get('retry-after') !== null,
    setCookie: res.headers.get('set-cookie'),
  };
}

describe('POST /api/auth/login — device cookie', () => {
  it('a successful sign-in sets lf_device next to the session (HttpOnly, SameSite=Lax, Path=/, 180 days)', async () => {
    const res = await login(KNOWN, CORRECT);
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^lf_guest=/);
    const flags = deviceSetCookie(res)!.split('; ').slice(1);
    expect(flags).toEqual(['Path=/', `Max-Age=${180 * DAY}`, 'HttpOnly', 'SameSite=Lax']);
    // The session cookie still reads back (the combined header too).
    expect(readGuestSession(res.headers.get('set-cookie'), SECRET)?.uid).toBe(USERS[KNOWN].id);
    expect(deviceSetCookie(res)!.toLowerCase()).not.toContain('owner');
  });

  it('failures and lockouts never set it, and an unknown email never gets one', async () => {
    for (let i = 0; i < 11; i += 1) {
      expect(deviceSetCookie(await login(KNOWN, 'wrong'))).toBeUndefined();
      expect(deviceSetCookie(await login(UNKNOWN, CORRECT))).toBeUndefined();
    }
  });

  it('a locked account still lets a known device in', async () => {
    const device = await knownDevice();
    await lockAccount();
    const res = await login(KNOWN, CORRECT, device);
    expect(res.status).toBe(200);
    expect(readGuestSession(res.headers.get('set-cookie'), SECRET)?.uid).toBe(USERS[KNOWN].id);
    expect(recordSession).toHaveBeenCalled();
    // ...and gets its device cookie refreshed (fresh nonce).
    expect(devicePair(res)).not.toBe(device);
  });

  it("the device's success does not lift the lock for browsers without one", async () => {
    const device = await knownDevice();
    await lockAccount();
    expect((await login(KNOWN, CORRECT, device)).status).toBe(200);
    expect((await login(KNOWN, CORRECT)).status).toBe(429);
  });

  it('a wrong password from a known device is still a 401', async () => {
    const device = await knownDevice();
    await lockAccount();
    const res = await login(KNOWN, 'wrong', device);
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('a known device has its own bucket: after 10 failures it is untrusted and meets the account lock', async () => {
    const device = await knownDevice();
    await lockAccount();
    for (let i = 0; i < 10; i += 1) expect((await login(KNOWN, 'wrong', device)).status).toBe(401);
    getUserCredentialsByEmail.mockClear();
    verifyPassword.mockClear();
    const res = await login(KNOWN, CORRECT, device);
    expect(res.status).toBe(429);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(getUserCredentialsByEmail).not.toHaveBeenCalled();
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('an untrusted device is charged to the account counter; the owner’s other devices are unaffected', async () => {
    const stolen = await knownDevice();
    const laptop = await knownDevice();
    for (let i = 0; i < 10; i += 1) expect((await login(KNOWN, 'wrong', stolen)).status).toBe(401);
    // Device bucket spent; the account counter is still empty: 10 more, then the lock.
    for (let i = 0; i < 10; i += 1) expect((await login(KNOWN, 'wrong', stolen)).status).toBe(401);
    expect((await login(KNOWN, 'wrong', stolen)).status).toBe(429);
    expect((await login(KNOWN, CORRECT, stolen)).status).toBe(429);
    expect((await login(KNOWN, CORRECT)).status).toBe(429);
    expect((await login(KNOWN, CORRECT, laptop)).status).toBe(200);
  });

  it.each([
    ['forged (payload edited)', async () => {
      const real = await knownDevice();
      const [name, value] = real.split('=');
      const [body, mac] = value.split('.');
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      payload.subjects[0].iat -= 1;
      return `${name}=${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;
    }],
    ['MAC’d with the session secret itself', async () => {
      const real = await knownDevice();
      const body = real.split('=')[1].split('.')[0];
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
      return signSessionCookie(payload, { name: 'lf_device', secret: SECRET, maxAgeSeconds: 60 }).setCookieHeader.split(';')[0];
    }],
    ['expired (issued 181 days ago)', async () =>
      buildDeviceCookie(null, KNOWN, USERS[KNOWN].passwordHash, { now: Math.floor(Date.now() / 1000) - 181 * DAY })!.split(';')[0]],
    ['issued to another account', async () => knownDevice(SECOND)],
  ])('a device cookie that is %s does not get past the lock', async (_label, makeCookie) => {
    const cookie = await makeCookie();
    await lockAccount();
    getUserCredentialsByEmail.mockClear();
    const res = await login(KNOWN, CORRECT, cookie);
    expect(res.status).toBe(429);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(getUserCredentialsByEmail).not.toHaveBeenCalled();
  });

  it('responses are identical for unknown and known emails, whatever device cookie comes along', async () => {
    const stranger = await knownDevice(SECOND);
    const forged = `${stranger.split('.')[0]}.${'A'.repeat(43)}`;
    // KNOWN's own entry, issued before a password change.
    const stale = await knownDevice(KNOWN);
    changePassword(KNOWN, NEW_PASSWORD);
    for (const cookie of [null, stranger, forged, stale]) {
      resetAccountAttemptsForTests();
      const known = [];
      const unknown = [];
      for (let i = 0; i < 12; i += 1) known.push(await shape(await login(KNOWN, 'wrong', cookie)));
      for (let i = 0; i < 12; i += 1) unknown.push(await shape(await login(UNKNOWN, 'wrong', cookie)));
      expect(unknown).toEqual(known);
      expect(known.map((r) => r.status)).toEqual([...Array(10).fill(401), 429, 429]);
      expect(known.every((r) => r.setCookie === null)).toBe(true);
    }
  });

  it('one browser remembers several accounts', async () => {
    const first = await knownDevice(KNOWN);
    const both = await knownDevice(SECOND, login, first);
    await lockAccount(KNOWN);
    await lockAccount(SECOND);
    expect((await login(KNOWN, CORRECT, both)).status).toBe(200);
    expect((await login(SECOND, CORRECT, both)).status).toBe(200);
  });
});

describe('POST /api/auth/desktop-session (start) — the same device cookies', () => {
  it('a successful start sets lf_device with the same flags; failures do not', async () => {
    const res = await desktopStart(KNOWN, CORRECT);
    expect(res.status).toBe(200);
    const flags = deviceSetCookie(res)!.split('; ').slice(1);
    expect(flags).toEqual(['Path=/', `Max-Age=${180 * DAY}`, 'HttpOnly', 'SameSite=Lax']);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(deviceSetCookie(await desktopStart(KNOWN, 'wrong'))).toBeUndefined();
    expect(deviceSetCookie(await desktopStart(UNKNOWN, CORRECT))).toBeUndefined();
  });

  it.each(DOORS)('a device cookie from %s mints a desktop code while the account is locked', async (_label, door) => {
    const device = await knownDevice(KNOWN, door);
    await lockAccount();
    expect((await desktopStart(KNOWN, CORRECT)).status).toBe(429);
    storeDesktopHandoffCode.mockClear();
    const res = await desktopStart(KNOWN, CORRECT, device);
    expect(res.status).toBe(200);
    expect(storeDesktopHandoffCode).toHaveBeenCalledTimes(1);
    expect(deviceSetCookie(res)).toBeDefined();
  });

  it('a device cookie from the desktop door signs in on the login form while locked', async () => {
    const device = await knownDevice(KNOWN, desktopStart);
    await lockAccount();
    expect((await login(KNOWN, CORRECT, device)).status).toBe(200);
  });

  it("forged, expired and other-account cookies are refused on the desktop door too", async () => {
    const stranger = await knownDevice(SECOND);
    const expired = buildDeviceCookie(null, KNOWN, USERS[KNOWN].passwordHash, { now: Math.floor(Date.now() / 1000) - 181 * DAY })!.split(';')[0];
    const real = await knownDevice(KNOWN);
    const forged = `${real.split('.')[0]}.${'A'.repeat(43)}`;
    await lockAccount();
    for (const cookie of [stranger, expired, forged]) {
      const res = await desktopStart(KNOWN, CORRECT, cookie);
      expect(res.status).toBe(429);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(storeDesktopHandoffCode).not.toHaveBeenCalled();
  });

  it('device buckets are shared by both doors', async () => {
    const device = await knownDevice();
    await lockAccount();
    for (let i = 0; i < 5; i += 1) expect((await login(KNOWN, 'wrong', device)).status).toBe(401);
    for (let i = 0; i < 5; i += 1) expect((await desktopStart(KNOWN, 'wrong', device)).status).toBe(401);
    expect((await desktopStart(KNOWN, CORRECT, device)).status).toBe(429);
    expect((await login(KNOWN, CORRECT, device)).status).toBe(429);
  });

  it('unknown and known emails look the same on the desktop door with a stranger’s device cookie', async () => {
    const stranger = await knownDevice(SECOND);
    resetAccountAttemptsForTests();
    const known = [];
    const unknown = [];
    for (let i = 0; i < 11; i += 1) known.push(await shape(await desktopStart(KNOWN, 'wrong', stranger)));
    for (let i = 0; i < 11; i += 1) unknown.push(await shape(await desktopStart(UNKNOWN, 'wrong', stranger)));
    expect(unknown).toEqual(known);
    expect(known.map((r) => r.status)).toEqual([...Array(10).fill(401), 429]);
  });
});

// Reviewer finding: a device cookie outlived a password change, so whoever
// had signed in once kept a private bucket of 10 guesses / 15 min outside
// the account lock for 180 days. Each entry is now bound to the password
// hash it was issued under.
describe.each(DOORS)('after a password change — %s', (_label, door) => {
  it('the old device cookie no longer gets past the account lock (and the password is never checked)', async () => {
    const stale = await knownDevice(KNOWN, door);
    changePassword(KNOWN, NEW_PASSWORD);
    await lockAccount();
    verifyPassword.mockClear();
    storeDesktopHandoffCode.mockClear();
    recordSession.mockClear();
    for (const password of [NEW_PASSWORD, CORRECT, 'wrong']) {
      const res = await door(KNOWN, password, stale);
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).not.toBeNull();
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(storeDesktopHandoffCode).not.toHaveBeenCalled();
    expect(recordSession).not.toHaveBeenCalled();
  });

  it('its guesses are charged to the account counter: no private bucket', async () => {
    const stale = await knownDevice(KNOWN, door);
    changePassword(KNOWN, NEW_PASSWORD);
    for (let i = 0; i < 10; i += 1) expect((await door(KNOWN, 'wrong', stale)).status).toBe(401);
    // Those 10 locked the account for everyone, the stale browser included.
    expect((await login(KNOWN, NEW_PASSWORD)).status).toBe(429);
    expect((await door(KNOWN, NEW_PASSWORD, stale)).status).toBe(429);
  });

  it('a fresh sign-in issues a new entry bound to the new password, which gets past a later lock', async () => {
    const stale = await knownDevice(KNOWN, door);
    changePassword(KNOWN, NEW_PASSWORD);
    const res = await door(KNOWN, NEW_PASSWORD, stale);
    expect(res.status).toBe(200);
    const fresh = devicePair(res);
    expect(fresh).not.toBe(stale);
    await lockAccount();
    expect((await door(KNOWN, NEW_PASSWORD, fresh)).status).toBe(200);
    expect((await door(KNOWN, NEW_PASSWORD, stale)).status).toBe(429);
  });

  it("only that account's entry goes stale; other accounts in the same cookie keep theirs", async () => {
    const first = await knownDevice(KNOWN, door);
    const both = await knownDevice(SECOND, door, first);
    changePassword(KNOWN, NEW_PASSWORD);
    await lockAccount(KNOWN);
    await lockAccount(SECOND);
    expect((await door(SECOND, CORRECT, both)).status).toBe(200);
    expect((await door(KNOWN, NEW_PASSWORD, both)).status).toBe(429);
  });

  it('unknown and known emails still look the same with the stale cookie', async () => {
    const stale = await knownDevice(KNOWN, door);
    changePassword(KNOWN, NEW_PASSWORD);
    resetAccountAttemptsForTests();
    const known = [];
    const unknown = [];
    for (let i = 0; i < 12; i += 1) known.push(await shape(await door(KNOWN, 'wrong', stale)));
    for (let i = 0; i < 12; i += 1) unknown.push(await shape(await door(UNKNOWN, 'wrong', stale)));
    expect(unknown).toEqual(known);
    expect(known.map((r) => r.status)).toEqual([...Array(10).fill(401), 429, 429]);
    expect(known.every((r) => r.setCookie === null)).toBe(true);
  });

  it('a deleted account’s entry is not trusted either', async () => {
    const device = await knownDevice(KNOWN, door);
    USERS[KNOWN] = { ...USERS[KNOWN], deletedAt: new Date() } as unknown as ReturnType<typeof userRow>;
    await lockAccount();
    const res = await door(KNOWN, CORRECT, device);
    expect(res.status).toBe(429);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
