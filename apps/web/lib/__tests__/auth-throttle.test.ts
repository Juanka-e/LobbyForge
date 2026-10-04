import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security follow-up: the per-account sign-in failure limit.
 */

const { evalMock, delMock } = vi.hoisted(() => ({ evalMock: vi.fn(), delMock: vi.fn() }));
vi.mock('@/lib/redis', () => ({ redis: { eval: evalMock, del: delMock } }));

import {
  PASSWORD_CHANGE_ACCOUNT_LIMIT,
  SIGN_IN_ACCOUNT_LIMIT,
  SIGN_IN_DEVICE_LIMIT,
  accountAttemptKey,
  accountLockedResponse,
  beginAccountAttempt,
  beginSignInAttempt,
  clearAccountAttempts,
  confirmSignInDevice,
  deviceAttemptKey,
  finishSignInAttempt,
  resetAccountAttemptsForTests,
} from '../auth-throttle.js';

const signIn = (email: string) => ({ scope: 'sign-in', email }) as const;
const reauthSubject = (userId: string) => ({ scope: 'reauth', userId }) as const;

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
    expect((await beginAccountAttempt(reauthSubject('a@example.com'))).allowed).toBe(true);
  });

  it('allows 5 current-password attempts per user', async () => {
    expect(PASSWORD_CHANGE_ACCOUNT_LIMIT).toEqual({ maxAttempts: 5, windowMs: 15 * 60_000 });
    const results = await attempts(reauthSubject('user-1'), 6);
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

describe('beginSignInAttempt — device cookies (in-process store)', () => {
  const EMAIL = 'owner@example.com';
  const NONCE = 'n'.repeat(22);
  const OTHER_NONCE = 'm'.repeat(22);
  const fromDevice = (nonce = NONCE, email = EMAIL) => ({ email, deviceNonce: nonce });
  const noDevice = (email = EMAIL) => ({ email, deviceNonce: null });

  async function signInAttempts(subject: Parameters<typeof beginSignInAttempt>[0], n: number) {
    const results = [];
    for (let i = 0; i < n; i += 1) results.push(await beginSignInAttempt(subject));
    return results;
  }

  it('without a device it is the account counter, exactly as before', async () => {
    const results = await signInAttempts(noDevice(), 11);
    expect(results.slice(0, 10).every((r) => r.allowed && r.path === 'account')).toBe(true);
    expect(results[10].allowed).toBe(false);
    expect((await beginAccountAttempt(signIn(EMAIL))).allowed).toBe(false);
  });

  it('a known device is not refused by the account-wide lock', async () => {
    await signInAttempts(noDevice(), 11);
    expect((await beginSignInAttempt(noDevice())).allowed).toBe(false);
    await expect(beginSignInAttempt(fromDevice())).resolves.toEqual({ allowed: true, path: 'device' });
  });

  it('device attempts are not charged to the account counter', async () => {
    await signInAttempts(fromDevice(), 10);
    const results = await signInAttempts(noDevice(), 11);
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('a device gets 10 attempts in 15 minutes; then it is untrusted and charged to the account counter', async () => {
    expect(SIGN_IN_DEVICE_LIMIT).toEqual({ maxAttempts: 10, windowMs: 15 * 60_000 });
    const results = await signInAttempts(fromDevice(), 11);
    expect(results.slice(0, 10).every((r) => r.allowed && r.path === 'device')).toBe(true);
    expect(results[10]).toEqual({ allowed: true, path: 'untrusted-device' });
    // 1 untrusted attempt already on the account counter: 9 more, then locked.
    const more = await signInAttempts(fromDevice(), 10);
    expect(more.slice(0, 9).every((r) => r.allowed && r.path === 'untrusted-device')).toBe(true);
    expect(more[9].allowed).toBe(false);
    expect((await beginSignInAttempt(noDevice())).allowed).toBe(false);
  });

  it('an untrusted device is refused while the account is locked', async () => {
    await signInAttempts(noDevice(), 10);
    await signInAttempts(fromDevice(), 10);
    const refused = await beginSignInAttempt(fromDevice());
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.retryAfterSeconds).toBeGreaterThan(14 * 60);
  });

  it('the device stays untrusted until its own window ends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T10:00:00Z'));
    await signInAttempts(fromDevice(), 10);
    vi.setSystemTime(new Date('2026-10-03T10:14:00Z'));
    expect(await beginSignInAttempt(fromDevice())).toEqual({ allowed: true, path: 'untrusted-device' });
    vi.setSystemTime(new Date('2026-10-03T10:15:01Z'));
    expect(await beginSignInAttempt(fromDevice())).toEqual({ allowed: true, path: 'device' });
  });

  it('buckets are per device and per account', async () => {
    await signInAttempts(fromDevice(NONCE), 10);
    expect(await beginSignInAttempt(fromDevice(NONCE))).toEqual({ allowed: true, path: 'untrusted-device' });
    expect(await beginSignInAttempt(fromDevice(OTHER_NONCE))).toEqual({ allowed: true, path: 'device' });
    expect(await beginSignInAttempt(fromDevice(NONCE, 'other@example.com'))).toEqual({ allowed: true, path: 'device' });
  });

  it('a device success clears only its own bucket, never the account lock', async () => {
    await signInAttempts(noDevice(), 10);
    await signInAttempts(fromDevice(), 9);
    await finishSignInAttempt(fromDevice(), 'device');
    expect((await beginSignInAttempt(noDevice())).allowed).toBe(false);
    const results = await signInAttempts(fromDevice(), 10);
    expect(results.every((r) => r.allowed && r.path === 'device')).toBe(true);
  });

  it('an untrusted-device success resets nothing', async () => {
    await signInAttempts(noDevice(), 5);
    await signInAttempts(fromDevice(), 11); // the 11th is charged to the account (6 now)
    await finishSignInAttempt(fromDevice(), 'untrusted-device');
    const results = await signInAttempts(noDevice(), 5);
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, false]);
    expect((await beginSignInAttempt(fromDevice())).allowed).toBe(false);
  });

  it('an account-path success clears the account counter, as before', async () => {
    await signInAttempts(noDevice(), 9);
    await finishSignInAttempt(noDevice(), 'account');
    const results = await signInAttempts(noDevice(), 11);
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });
});

describe('beginSignInAttempt — device cookies (Redis store)', () => {
  const NONCE = 'n'.repeat(22);

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
  });

  it('counts a device attempt under its own HMAC key name and leaves the account counter alone', async () => {
    evalMock.mockResolvedValue([1, 900_000]);
    await expect(beginSignInAttempt({ email: 'Owner@Example.com', deviceNonce: NONCE })).resolves.toEqual({
      allowed: true,
      path: 'device',
    });
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, , key, windowMs] = evalMock.mock.calls[0] as [string, number, string, string];
    expect(script).toContain('INCR');
    expect(windowMs).toBe(String(15 * 60_000));
    expect(key).toMatch(/^lf:production:rate-limit:auth-device:sign-in:[0-9a-f]{64}$/);
    expect(key).toBe(deviceAttemptKey('owner@example.com', NONCE));
    expect(key.toLowerCase()).not.toContain('owner');
    expect(key).not.toContain(NONCE);
    expect(key).not.toBe(accountAttemptKey(signIn('owner@example.com')));
    expect(deviceAttemptKey('owner@example.com', 'm'.repeat(22))).not.toBe(key);
  });

  it('a tripped device is charged to the account counter next', async () => {
    evalMock.mockResolvedValueOnce([11, 300_000]).mockResolvedValueOnce([4, 600_000]);
    await expect(beginSignInAttempt({ email: 'owner@example.com', deviceNonce: NONCE })).resolves.toEqual({
      allowed: true,
      path: 'untrusted-device',
    });
    expect(evalMock.mock.calls[1]?.[2]).toBe(accountAttemptKey(signIn('owner@example.com')));
  });

  it('fails closed when Redis is unavailable on the device path', async () => {
    evalMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(beginSignInAttempt({ email: 'owner@example.com', deviceNonce: NONCE })).resolves.toEqual({
        allowed: false,
        retryAfterSeconds: 5,
      });
      expect(evalMock).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a device success DELs the device key only; an untrusted-device success DELs nothing', async () => {
    await finishSignInAttempt({ email: 'owner@example.com', deviceNonce: NONCE }, 'device');
    expect(delMock).toHaveBeenCalledTimes(1);
    expect(delMock).toHaveBeenCalledWith(deviceAttemptKey('owner@example.com', NONCE));
    delMock.mockClear();
    await finishSignInAttempt({ email: 'owner@example.com', deviceNonce: NONCE }, 'untrusted-device');
    expect(delMock).not.toHaveBeenCalled();
    await finishSignInAttempt({ email: 'owner@example.com', deviceNonce: null }, 'account');
    expect(delMock).toHaveBeenCalledWith(accountAttemptKey(signIn('owner@example.com')));
  });
});

describe('confirmSignInDevice — a device entry from before a password change', () => {
  const EMAIL = 'owner@example.com';
  const NONCE = 'n'.repeat(22);
  const fromDevice = { email: EMAIL, deviceNonce: NONCE };
  const noDevice = { email: EMAIL, deviceNonce: null };

  /** One attempt through both halves, as the sign-in routes run them. */
  async function attempt(subject: typeof fromDevice | typeof noDevice, deviceHolds: boolean) {
    const begun = await beginSignInAttempt(subject);
    return begun.allowed ? confirmSignInDevice(subject, begun, deviceHolds) : begun;
  }

  async function lockAccount() {
    for (let i = 0; i < 10; i += 1) expect((await attempt(noDevice, false)).allowed).toBe(true);
    expect((await attempt(noDevice, false)).allowed).toBe(false);
  }

  it('a device whose binding holds keeps its own bucket, past the account lock', async () => {
    await lockAccount();
    await expect(attempt(fromDevice, true)).resolves.toEqual({ allowed: true, path: 'device' });
  });

  it('a device whose binding no longer holds is refused while the account is locked', async () => {
    await lockAccount();
    const refused = await attempt(fromDevice, false);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.retryAfterSeconds).toBeGreaterThan(14 * 60);
  });

  it('its attempts are charged to the account counter (no private bucket): 10, then locked for everyone', async () => {
    const results = [];
    for (let i = 0; i < 11; i += 1) results.push(await attempt(fromDevice, false));
    expect(results.slice(0, 10).every((r) => r.allowed && r.path === 'account')).toBe(true);
    expect(results[10].allowed).toBe(false);
    expect((await beginSignInAttempt(noDevice)).allowed).toBe(false);
  });

  it('a success on the withdrawn path clears the account counter, like any browser without a device cookie', async () => {
    for (let i = 0; i < 9; i += 1) await attempt(noDevice, false);
    const ok = await attempt(fromDevice, false);
    expect(ok).toEqual({ allowed: true, path: 'account' });
    await finishSignInAttempt(fromDevice, 'account');
    const results = [];
    for (let i = 0; i < 11; i += 1) results.push(await attempt(noDevice, false));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('leaves account and untrusted-device attempts alone (never charged twice)', async () => {
    await expect(confirmSignInDevice(noDevice, { allowed: true, path: 'account' }, false)).resolves.toEqual({
      allowed: true,
      path: 'account',
    });
    await expect(
      confirmSignInDevice(fromDevice, { allowed: true, path: 'untrusted-device' }, false)
    ).resolves.toEqual({ allowed: true, path: 'untrusted-device' });
    // Neither touched the account counter: still 10 attempts before the lock.
    const results = [];
    for (let i = 0; i < 11; i += 1) results.push(await beginSignInAttempt(noDevice));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('fails closed when Redis is unavailable while withdrawing the device path', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    evalMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(confirmSignInDevice(fromDevice, { allowed: true, path: 'device' }, false)).resolves.toEqual({
        allowed: false,
        retryAfterSeconds: 5,
      });
      expect(evalMock.mock.calls[0]?.[2]).toBe(accountAttemptKey(signIn(EMAIL)));
    } finally {
      errorSpy.mockRestore();
    }
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
