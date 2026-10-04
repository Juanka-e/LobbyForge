import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security follow-up: a per-ACCOUNT failure limit shared by
 * POST /api/auth/login and POST /api/auth/desktop-session (start). Each
 * route's per-IP bucket alone let a distributed attacker guess forever.
 * Unknown emails must count and lock exactly like known ones.
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
vi.mock('@/lib/desktop-handoff-codes', () => ({
  DESKTOP_HANDOFF_TTL_SECONDS: 300,
  credentialFingerprint: () => 'fingerprint',
  storeDesktopHandoffCode,
}));

import { resetAccountAttemptsForTests } from '@/lib/auth-throttle';

const KNOWN = 'owner@example.com';
const UNKNOWN = 'nobody@example.com';
const USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: KNOWN,
  displayName: 'Owner',
  passwordHash: 'stored-hash',
  deletedAt: null,
};

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = 'x'.repeat(32);
  resetAccountAttemptsForTests();
  getUserCredentialsByEmail.mockReset().mockImplementation(async (_db: unknown, email: string) =>
    email === KNOWN ? USER : null
  );
  verifyPassword.mockReset().mockImplementation(async (password: string, hash: string) =>
    hash === 'stored-hash' && password === 'correct password'
  );
  recordSession.mockReset().mockResolvedValue(undefined);
  storeDesktopHandoffCode.mockReset().mockResolvedValue(undefined);
});

async function login(email: string, password: string): Promise<Response> {
  const { POST } = await import('../route.js');
  return POST(
    new Request('https://example.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
    {}
  );
}

async function desktopStart(email: string, password: string): Promise<Response> {
  const { POST } = await import('../../desktop-session/route.js');
  return POST(
    new Request('https://example.test/api/auth/desktop-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
    {}
  );
}

/** Status + body with the clock-dependent fields removed. */
async function shape(res: Response) {
  const body = (await res.json()) as Record<string, unknown>;
  delete body.resetAt;
  delete body.retryAfter;
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') !== null };
}

describe('per-account sign-in limit', () => {
  it('locks an account after 10 failures with the generic 429 and Retry-After', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await login(KNOWN, 'wrong')).status).toBe(401);
    }
    const locked = await login(KNOWN, 'wrong');
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(14 * 60);
    expect(locked.headers.get('set-cookie')).toBeNull();
    const body = (await locked.json()) as Record<string, unknown>;
    expect(body.error).toBe('Rate limit exceeded');
  });

  it('unknown emails count and lock exactly like known ones (no enumeration oracle)', async () => {
    const known = [];
    const unknown = [];
    for (let i = 0; i < 12; i += 1) known.push(await shape(await login(KNOWN, 'wrong')));
    for (let i = 0; i < 12; i += 1) unknown.push(await shape(await login(UNKNOWN, 'wrong')));
    expect(unknown).toEqual(known);
    expect(known.map((r) => r.status)).toEqual([...Array(10).fill(401), 429, 429]);
    // The unknown account still ran the dummy-hash verification each time.
    expect(verifyPassword.mock.calls.filter(([, hash]) => hash === 'dummy-hash')).toHaveLength(10);
  });

  it('refuses the CORRECT password while locked, without checking it', async () => {
    for (let i = 0; i < 10; i += 1) await login(KNOWN, 'wrong');
    getUserCredentialsByEmail.mockClear();
    verifyPassword.mockClear();
    const res = await login(KNOWN, 'correct password');
    expect(res.status).toBe(429);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(getUserCredentialsByEmail).not.toHaveBeenCalled();
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(recordSession).not.toHaveBeenCalled();
  });

  it('a successful sign-in resets the counter', async () => {
    for (let i = 0; i < 9; i += 1) await login(KNOWN, 'wrong');
    expect((await login(KNOWN, 'correct password')).status).toBe(200);
    for (let i = 0; i < 10; i += 1) {
      expect((await login(KNOWN, 'wrong')).status).toBe(401);
    }
    expect((await login(KNOWN, 'wrong')).status).toBe(429);
  });

  it('counts per account — another account is unaffected, email case does not matter', async () => {
    for (let i = 0; i < 10; i += 1) await login('Owner@Example.com', 'wrong');
    expect((await login(KNOWN, 'wrong')).status).toBe(429);
    expect((await login(UNKNOWN, 'wrong')).status).toBe(401);
  });

  it('a malformed body is not counted against anyone', async () => {
    for (let i = 0; i < 12; i += 1) {
      expect((await login('not-an-email', 'x')).status).toBe(400);
    }
    expect((await login(KNOWN, 'correct password')).status).toBe(200);
  });
});

describe('the desktop handoff start shares the same counter', () => {
  it('failures on both doors add up', async () => {
    for (let i = 0; i < 5; i += 1) expect((await login(KNOWN, 'wrong')).status).toBe(401);
    for (let i = 0; i < 5; i += 1) expect((await desktopStart(KNOWN, 'wrong')).status).toBe(401);
    expect((await login(KNOWN, 'wrong')).status).toBe(429);
    expect((await desktopStart(KNOWN, 'wrong')).status).toBe(429);
  });

  it('a lock from the login form stops a desktop code for the right password', async () => {
    for (let i = 0; i < 10; i += 1) await login(KNOWN, 'wrong');
    const res = await desktopStart(KNOWN, 'correct password');
    expect(res.status).toBe(429);
    expect(storeDesktopHandoffCode).not.toHaveBeenCalled();
  });

  it('unknown emails lock on the desktop door too', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await desktopStart(UNKNOWN, 'wrong')).status);
    expect(statuses).toEqual([...Array(10).fill(401), 429]);
  });

  it('a successful desktop start resets the counter', async () => {
    for (let i = 0; i < 9; i += 1) await login(KNOWN, 'wrong');
    expect((await desktopStart(KNOWN, 'correct password')).status).toBe(200);
    for (let i = 0; i < 10; i += 1) expect((await login(KNOWN, 'wrong')).status).toBe(401);
  });
});
