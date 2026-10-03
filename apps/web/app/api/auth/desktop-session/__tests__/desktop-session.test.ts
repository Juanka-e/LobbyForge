import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DP-07 — desktop session handoff contract:
 *  - start: valid credentials mint a one-time code (Redis, TTL); bad
 *    credentials 401 without enumeration
 *  - complete: burns the code, issues a session cookie; replay of a
 *    burned code 401; unknown code 401
 */

const { redisGet, redisSet, redisDel, redisGetdel, redisSadd, redisExpire } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  redisGetdel: vi.fn(),
  redisSadd: vi.fn(),
  redisExpire: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  redis: {
    get: redisGet,
    set: redisSet,
    del: redisDel,
    getdel: redisGetdel,
    sadd: redisSadd,
    expire: redisExpire,
  },
}));

const { getUserCredentialsByEmail, getUserCredentialsById } = vi.hoisted(() => ({
  getUserCredentialsByEmail: vi.fn(),
  getUserCredentialsById: vi.fn(),
}));
vi.mock('@lobbyforge/db', () => ({ getUserCredentialsByEmail, getUserCredentialsById }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));

const { verifyPassword } = vi.hoisted(() => ({ verifyPassword: vi.fn() }));
vi.mock('@/lib/password', () => ({
  verifyPassword,
  DUMMY_PASSWORD_HASH: 'scrypt$dummy',
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
}));

const { recordSession } = vi.hoisted(() => ({ recordSession: vi.fn() }));
vi.mock('@/lib/session-tracker', () => ({ recordSession }));

const envSnapshot = { ...process.env };
const PASSWORD_HASH = 'scrypt$real';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = 'x'.repeat(32);
  for (const fn of [
    redisGet, redisSet, redisDel, redisGetdel, redisSadd, redisExpire,
    getUserCredentialsByEmail, getUserCredentialsById, verifyPassword, recordSession,
  ]) {
    fn.mockReset();
  }
  recordSession.mockResolvedValue(undefined);
  redisSet.mockResolvedValue('OK');
  redisDel.mockResolvedValue(1);
  redisGetdel.mockResolvedValue(null);
  redisSadd.mockResolvedValue(1);
  redisExpire.mockResolvedValue(1);
  getUserCredentialsById.mockResolvedValue({
    id: 'u-1', email: 'o@x.test', displayName: 'Owner', passwordHash: PASSWORD_HASH, isGuest: false, deletedAt: null,
  });
});

/** A stored handoff record, minted under the account's current password unless told otherwise. */
function handoffRecord(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    userId: 'u-1',
    state: 's'.repeat(32),
    used: false,
    credential: createHash('sha256').update(PASSWORD_HASH).digest('hex'),
    ...overrides,
  });
}

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
  const STATE = 's'.repeat(32);

  it('atomically consumes (GETDEL) and sets a session cookie', async () => {
    redisGetdel.mockResolvedValue(handoffRecord());
    const res = await complete({ code: CODE, state: STATE });
    expect(res.status).toBe(200);
    expect(redisGetdel).toHaveBeenCalledWith(`lf:desktop-handoff:${CODE}`);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('lf_guest=');
  });

  it('LF-SEC-008: 401 for a WRONG state — and the code stays burned', async () => {
    redisGetdel.mockResolvedValue(handoffRecord());
    const res = await complete({ code: CODE, state: 'x'.repeat(32) });
    expect(res.status).toBe(401);
    // No re-set of the record — the GETDEL already consumed it.
    expect(redisSet).not.toHaveBeenCalled();
    // A second attempt sees nothing (simulated: getdel again → null).
    redisGetdel.mockResolvedValue(null);
    const res2 = await complete({ code: CODE, state: STATE });
    expect(res2.status).toBe(401);
  });

  it('LF-SEC-008: missing state fails validation', async () => {
    const res = await complete({ code: CODE });
    expect(res.status).toBe(400);
  });

  it('LF-SEC-008: PARALLEL completion — exactly one wins (atomic GETDEL)', async () => {
    const record = handoffRecord();
    // First caller gets the record; the concurrent second gets null —
    // exactly what Redis GETDEL guarantees.
    redisGetdel.mockResolvedValueOnce(record).mockResolvedValueOnce(null);
    const [a, b] = await Promise.all([
      complete({ code: CODE, state: STATE }),
      complete({ code: CODE, state: STATE }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
  });

  it('401 for an expired/unknown code', async () => {
    redisGetdel.mockResolvedValue(null);
    const res = await complete({ code: CODE, state: STATE });
    expect(res.status).toBe(401);
  });

  it('401 when the account no longer exists (code stays burned)', async () => {
    redisGetdel.mockResolvedValue(handoffRecord({ userId: 'gone' }));
    getUserCredentialsById.mockResolvedValue(null);
    const res = await complete({ code: CODE, state: STATE });
    expect(res.status).toBe(401);
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('400 for a too-short code', async () => {
    const res = await complete({ code: 'short', state: STATE });
    expect(res.status).toBe(400);
  });
});

// beta-review (S7): the handoff-minted session must be RECORDED (and so
// revocable by a password change) before the cookie is handed out.
describe('POST /api/auth/desktop-session/complete — beta-review S7 session tracking', () => {
  const CODE = 'c'.repeat(48);
  const STATE = 's'.repeat(32);

  it('records the minted session under the cookie gid', async () => {
    redisGetdel.mockResolvedValue(handoffRecord());
    const res = await complete({ code: CODE, state: STATE });
    expect(res.status).toBe(200);
    const { readGuestSession } = await import('@/lib/guest-session');
    const session = readGuestSession(res.headers.get('set-cookie'), 'x'.repeat(32));
    expect(session?.uid).toBe('u-1');
    expect(recordSession).toHaveBeenCalledWith('u-1', session?.gid, expect.any(Request));
  });

  it('outside production a tracking failure only logs', async () => {
    recordSession.mockRejectedValue(new Error('redis down'));
    redisGetdel.mockResolvedValue(handoffRecord());
    const res = await complete({ code: CODE, state: STATE });
    expect(res.status).toBe(200);
  });

  it('in production an unrecorded session is never handed out', async () => {
    const env = process.env as Record<string, string | undefined>;
    const previous = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      recordSession.mockRejectedValue(new Error('redis down'));
      redisGetdel.mockResolvedValue(handoffRecord());
      const res = await complete({ code: CODE, state: STATE });
      expect(res.status).toBe(503);
      expect(res.headers.get('set-cookie')).toBeNull();
    } finally {
      env.NODE_ENV = previous;
    }
  });

  it('no session is recorded when the handoff fails', async () => {
    redisGetdel.mockResolvedValue(null);
    const res = await complete({ code: CODE, state: STATE });
    expect(res.status).toBe(401);
    expect(recordSession).not.toHaveBeenCalled();
  });
});

// security-review AUTH-001: a handoff code is bound to the password it was
// minted under, and indexed per user so a password change can delete it.
describe('desktop session handoff — security-review AUTH-001 credential binding', () => {
  const CODE = 'c'.repeat(48);
  const STATE = 's'.repeat(32);

  it('stores a fingerprint of the password hash (never the hash) and indexes the code per user', async () => {
    getUserCredentialsByEmail.mockResolvedValue({
      id: 'u-1', email: 'o@x.test', displayName: 'Owner', passwordHash: PASSWORD_HASH, deletedAt: null,
    });
    verifyPassword.mockResolvedValue(true);
    const res = await start({ email: 'o@x.test', password: 'pw' });
    expect(res.status).toBe(200);
    const { code } = (await res.json()) as { code: string };

    const stored = JSON.parse(redisSet.mock.calls[0]?.[1] as string) as Record<string, unknown>;
    expect(stored.credential).toBe(createHash('sha256').update(PASSWORD_HASH).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(PASSWORD_HASH);
    expect(redisSadd).toHaveBeenCalledWith('lf:desktop-handoff:user:u-1', code);
    expect(redisExpire).toHaveBeenCalledWith('lf:desktop-handoff:user:u-1', 300);
  });

  it('401 when the password changed after the code was minted — no cookie, no session', async () => {
    redisGetdel.mockResolvedValue(handoffRecord());
    getUserCredentialsById.mockResolvedValue({
      id: 'u-1', email: 'o@x.test', displayName: 'Owner', passwordHash: 'scrypt$new', isGuest: false, deletedAt: null,
    });
    const res = await complete({ code: CODE, state: STATE });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(recordSession).not.toHaveBeenCalled();
  });

  it('401 for a record without a credential fingerprint (minted before this fix)', async () => {
    redisGetdel.mockResolvedValue(JSON.stringify({ userId: 'u-1', state: STATE, used: false }));
    const res = await complete({ code: CODE, state: STATE });
    expect(res.status).toBe(401);
    expect(recordSession).not.toHaveBeenCalled();
  });

  it('401 when the account no longer has a password', async () => {
    redisGetdel.mockResolvedValue(handoffRecord());
    getUserCredentialsById.mockResolvedValue({
      id: 'u-1', email: 'o@x.test', displayName: 'Owner', passwordHash: null, isGuest: false, deletedAt: null,
    });
    const res = await complete({ code: CODE, state: STATE });
    expect(res.status).toBe(401);
  });

  it('400 for a code outside the URL-safe alphabet (cannot address the per-user index)', async () => {
    const res = await complete({ code: `user:${'0'.repeat(40)}`, state: STATE });
    expect(res.status).toBe(400);
    expect(redisGetdel).not.toHaveBeenCalled();
  });
});
