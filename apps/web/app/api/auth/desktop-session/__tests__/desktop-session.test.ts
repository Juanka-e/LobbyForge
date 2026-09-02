import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DP-07 — desktop session handoff contract:
 *  - start: valid credentials mint a one-time code (Redis, TTL); bad
 *    credentials 401 without enumeration
 *  - complete: burns the code, issues a session cookie; replay of a
 *    burned code 401; unknown code 401
 */

const { redisGet, redisSet, redisDel } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  redis: { get: redisGet, set: redisSet, del: redisDel },
}));

const { getUserCredentialsByEmail, getUserById } = vi.hoisted(() => ({
  getUserCredentialsByEmail: vi.fn(),
  getUserById: vi.fn(),
}));
vi.mock('@lobbyforge/db', () => ({ getUserCredentialsByEmail, getUserById }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));

const { verifyPassword } = vi.hoisted(() => ({ verifyPassword: vi.fn() }));
vi.mock('@/lib/password', () => ({
  verifyPassword,
  DUMMY_PASSWORD_HASH: 'scrypt$dummy',
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
}));

const envSnapshot = { ...process.env };

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = 'x'.repeat(32);
  for (const fn of [redisGet, redisSet, redisDel, getUserCredentialsByEmail, getUserById, verifyPassword]) {
    fn.mockReset();
  }
  redisSet.mockResolvedValue('OK');
  redisDel.mockResolvedValue(1);
  getUserById.mockResolvedValue({ id: 'u-1', displayName: 'Owner', deletedAt: null });
});

async function start(body: unknown): Promise<Response> {
  const { POST } = await import('../route.js');
  return POST(
    new Request('http://localhost/api/auth/desktop-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {}
  );
}

async function complete(body: unknown): Promise<Response> {
  const { POST } = await import('../complete/route.js');
  return POST(
    new Request('http://localhost/api/auth/desktop-session/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {}
  );
}

describe('POST /api/auth/desktop-session (start)', () => {
  it('mints a one-time code with a TTL for valid credentials', async () => {
    getUserCredentialsByEmail.mockResolvedValue({
      id: 'u-1', email: 'o@x.test', displayName: 'Owner', passwordHash: 'scrypt$real', deletedAt: null,
    });
    verifyPassword.mockResolvedValue(true);
    const res = await start({ email: 'o@x.test', password: 'pw' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; state: string; redirectUrl: string };
    expect(body.code.length).toBeGreaterThanOrEqual(43);
    expect(body.redirectUrl).toMatch(/^lobbyforge:\/\/session\/complete\?/);
    expect(redisSet).toHaveBeenCalledWith(
      expect.stringContaining('lf:desktop-handoff:'),
      expect.any(String),
      'EX',
      300
    );
  });

  it('401 for bad credentials (no enumeration shape)', async () => {
    getUserCredentialsByEmail.mockResolvedValue(null);
    verifyPassword.mockResolvedValue(false);
    const res = await start({ email: 'no@x.test', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('400 for a malformed body', async () => {
    const res = await start({ email: 'not-an-email', password: '' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/desktop-session/complete', () => {
  const CODE = 'c'.repeat(48);

  it('burns the code and sets a session cookie', async () => {
    redisGet.mockResolvedValue(JSON.stringify({ userId: 'u-1', state: 's', used: false }));
    const res = await complete({ code: CODE });
    expect(res.status).toBe(200);
    expect(redisDel).toHaveBeenCalledWith(`lf:desktop-handoff:${CODE}`);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('lf_guest=');
  });

  it('401 for an expired/unknown code', async () => {
    redisGet.mockResolvedValue(null);
    const res = await complete({ code: CODE });
    expect(res.status).toBe(401);
  });

  it('401 + delete on a REPLAYED (already used) code', async () => {
    redisGet.mockResolvedValue(JSON.stringify({ userId: 'u-1', state: 's', used: true }));
    const res = await complete({ code: CODE });
    expect(res.status).toBe(401);
    expect(redisDel).toHaveBeenCalled();
  });

  it('401 when the account no longer exists', async () => {
    redisGet.mockResolvedValue(JSON.stringify({ userId: 'gone', state: 's', used: false }));
    getUserById.mockResolvedValue(null);
    const res = await complete({ code: CODE });
    expect(res.status).toBe(401);
  });

  it('400 for a too-short code', async () => {
    const res = await complete({ code: 'short' });
    expect(res.status).toBe(400);
  });
});
