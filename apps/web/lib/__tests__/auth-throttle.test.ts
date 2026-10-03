import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security follow-up: the per-account sign-in failure limit.
 */

const { evalMock, delMock } = vi.hoisted(() => ({ evalMock: vi.fn(), delMock: vi.fn() }));
vi.mock('@/lib/redis', () => ({ redis: { eval: evalMock, del: delMock } }));

import {
  PASSWORD_CHANGE_ACCOUNT_LIMIT,
  SIGN_IN_ACCOUNT_LIMIT,
  accountAttemptKey,
  accountLockedResponse,
  beginAccountAttempt,
  clearAccountAttempts,
  resetAccountAttemptsForTests,
} from '../auth-throttle.js';

const signIn = (email: string) => ({ scope: 'sign-in', email }) as const;
const passwordChange = (userId: string) => ({ scope: 'password-change', userId }) as const;

async function attempts(subject: Parameters<typeof beginAccountAttempt>[0], n: number) {
  const results = [];
  for (let i = 0; i < n; i += 1) results.push(await beginAccountAttempt(subject));
  return results;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'k'.repeat(48));
  resetAccountAttemptsForTests();
  evalMock.mockReset();
  delMock.mockReset().mockResolvedValue(1);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('beginAccountAttempt (in-process store)', () => {
  it('allows 10 sign-in attempts per account in 15 minutes, then refuses with Retry-After', async () => {
    expect(SIGN_IN_ACCOUNT_LIMIT).toEqual({ maxAttempts: 10, windowMs: 15 * 60_000 });
    const results = await attempts(signIn('owner@example.com'), 11);
    expect(results.slice(0, 10).every((r) => r.allowed)).toBe(true);
    const refused = results[10];
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.retryAfterSeconds).toBeGreaterThan(14 * 60);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
    }
  });

  it('normalises the email (case and spaces share one counter)', async () => {
    await attempts(signIn('Owner@Example.com'), 5);
    await attempts(signIn(' owner@example.com '), 5);
    expect((await beginAccountAttempt(signIn('OWNER@EXAMPLE.COM'))).allowed).toBe(false);
  });

  it('keeps accounts and scopes apart', async () => {
    await attempts(signIn('a@example.com'), 10);
    expect((await beginAccountAttempt(signIn('a@example.com'))).allowed).toBe(false);
    expect((await beginAccountAttempt(signIn('b@example.com'))).allowed).toBe(true);
    expect((await beginAccountAttempt(passwordChange('a@example.com'))).allowed).toBe(true);
  });

  it('allows 5 current-password attempts per user', async () => {
    expect(PASSWORD_CHANGE_ACCOUNT_LIMIT).toEqual({ maxAttempts: 5, windowMs: 15 * 60_000 });
    const results = await attempts(passwordChange('user-1'), 6);
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false]);
  });

  it('a successful check clears the counter', async () => {
    await attempts(signIn('owner@example.com'), 9);
    await clearAccountAttempts(signIn('owner@example.com'));
    const results = await attempts(signIn('owner@example.com'), 11);
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('the lock ends when the window (fixed from the first attempt) ends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T10:00:00Z'));
    await attempts(signIn('owner@example.com'), 10);
    vi.setSystemTime(new Date('2026-10-03T10:14:00Z'));
    expect((await beginAccountAttempt(signIn('owner@example.com'))).allowed).toBe(false);
    vi.setSystemTime(new Date('2026-10-03T10:15:01Z'));
    expect((await beginAccountAttempt(signIn('owner@example.com'))).allowed).toBe(true);
  });
});

describe('beginAccountAttempt (Redis store)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
  });

  it('counts atomically in Redis under a key that never contains the email', async () => {
    evalMock.mockResolvedValue([3, 600_000]);
    await expect(beginAccountAttempt(signIn('Owner@Example.com'))).resolves.toEqual({ allowed: true });
    const [script, keyCount, key, windowMs] = evalMock.mock.calls[0] as [string, number, string, string];
    expect(script).toContain('INCR');
    expect(keyCount).toBe(1);
    expect(windowMs).toBe(String(15 * 60_000));
    expect(key).toMatch(/^lf:production:rate-limit:auth-account:sign-in:[0-9a-f]{64}$/);
    expect(key.toLowerCase()).not.toContain('owner');
    expect(key).not.toContain('example');
    // Keyed with the session secret: a plain hash of the address would be
    // a dictionary lookup away.
    expect(key).toBe(accountAttemptKey(signIn('owner@example.com')));
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'z'.repeat(48));
    expect(accountAttemptKey(signIn('owner@example.com'))).not.toBe(key);
  });

  it('refuses past the limit with the remaining window as Retry-After', async () => {
    evalMock.mockResolvedValue([11, 90_500]);
    await expect(beginAccountAttempt(signIn('owner@example.com'))).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 91,
    });
  });

  it('fails closed when Redis is unavailable', async () => {
    evalMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(beginAccountAttempt(signIn('owner@example.com'))).resolves.toEqual({
        allowed: false,
        retryAfterSeconds: 5,
      });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('clears with DEL, and a failed DEL only logs', async () => {
    await clearAccountAttempts(signIn('owner@example.com'));
    expect(delMock).toHaveBeenCalledWith(accountAttemptKey(signIn('owner@example.com')));
    delMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(clearAccountAttempts(signIn('owner@example.com'))).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('LOBBYFORGE_RATE_LIMIT_STORE=memory keeps production in-process', async () => {
    vi.stubEnv('LOBBYFORGE_RATE_LIMIT_STORE', 'memory');
    await expect(beginAccountAttempt(signIn('owner@example.com'))).resolves.toEqual({ allowed: true });
    expect(evalMock).not.toHaveBeenCalled();
  });
});

describe('accountLockedResponse', () => {
  it('is the same generic 429 as the per-IP limiter', async () => {
    const res = accountLockedResponse(120);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
    expect(res.headers.get('x-ratelimit-reset')).toBeTruthy();
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['error', 'resetAt', 'retryAfter']);
    expect(body.error).toBe('Rate limit exceeded');
    expect(body.retryAfter).toBe(120);
  });
});
