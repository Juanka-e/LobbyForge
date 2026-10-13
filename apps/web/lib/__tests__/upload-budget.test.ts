/**
 * security-review FILE-001: the per-address daily upload byte budget
 * (lib/upload-budget.ts) — memory store outside production, Redis in
 * production (fail closed), and the instance-wide backstop when client
 * addresses are unknown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  address: '203.0.113.5' as string,
  evalImpl: null as null | ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock('@/lib/security-headers', () => ({ resolveClientAddress: () => h.address }));
vi.mock('@/lib/redis', () => ({
  redis: {
    eval: (...args: unknown[]) => {
      if (!h.evalImpl) throw new Error('redis not expected');
      return h.evalImpl(...args);
    },
  },
}));

import {
  __resetUploadBudgetMemory,
  consumeUploadBudget,
  reserveUploadBytes,
  UPLOAD_BUDGET_WINDOW_MS,
  UPLOAD_BYTES_PER_ADDRESS,
  UPLOAD_BYTES_UNKNOWN_BACKSTOP,
} from '../upload-budget';

const env = { NODE_ENV: process.env.NODE_ENV, STORE: process.env.LOBBYFORGE_RATE_LIMIT_STORE };
const req = () => new Request('https://example.test/api/users/me/avatar', { method: 'POST' });

beforeEach(() => {
  __resetUploadBudgetMemory();
  h.address = '203.0.113.5';
  h.evalImpl = null;
  delete process.env.LOBBYFORGE_RATE_LIMIT_STORE;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  (process.env as Record<string, string | undefined>).NODE_ENV = env.NODE_ENV;
  if (env.STORE === undefined) delete process.env.LOBBYFORGE_RATE_LIMIT_STORE;
  else process.env.LOBBYFORGE_RATE_LIMIT_STORE = env.STORE;
});

describe('upload byte budget (memory store)', () => {
  it('allows uploads up to 64 MiB per address per day, then refuses with 429', async () => {
    expect(UPLOAD_BYTES_PER_ADDRESS).toBe(64 * 1024 * 1024);
    expect(await reserveUploadBytes(req(), UPLOAD_BYTES_PER_ADDRESS - 100)).toMatchObject({ ok: true });
    expect(await reserveUploadBytes(req(), 100)).toMatchObject({ ok: true, usedBytes: UPLOAD_BYTES_PER_ADDRESS });

    const refused = await consumeUploadBudget(req(), 1);
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await refused?.json()).toMatchObject({ code: 'upload_budget_exceeded' });
  });

  it('a refused reservation consumes nothing', async () => {
    await reserveUploadBytes(req(), UPLOAD_BYTES_PER_ADDRESS - 10);
    expect((await reserveUploadBytes(req(), 11)).ok).toBe(false);
    expect((await reserveUploadBytes(req(), 10)).ok).toBe(true);
  });

  it('keeps a separate budget per address', async () => {
    await reserveUploadBytes(req(), UPLOAD_BYTES_PER_ADDRESS);
    h.address = '203.0.113.6';
    expect((await reserveUploadBytes(req(), 1024)).ok).toBe(true);
  });

  it('opens a fresh budget after 24 hours', async () => {
    vi.useFakeTimers();
    await reserveUploadBytes(req(), UPLOAD_BYTES_PER_ADDRESS);
    expect((await reserveUploadBytes(req(), 1)).ok).toBe(false);
    vi.advanceTimersByTime(UPLOAD_BUDGET_WINDOW_MS + 1);
    expect((await reserveUploadBytes(req(), 1)).ok).toBe(true);
  });

  it('without a trusted proxy (address "unknown") uses one larger instance-wide backstop', async () => {
    h.address = 'unknown';
    expect((await reserveUploadBytes(req(), UPLOAD_BYTES_PER_ADDRESS * 2)).ok).toBe(true);
    const refused = await reserveUploadBytes(req(), UPLOAD_BYTES_UNKNOWN_BACKSTOP);
    expect(refused).toMatchObject({ ok: false, reason: 'exhausted', budgetBytes: UPLOAD_BYTES_UNKNOWN_BACKSTOP });
  });
});

describe('upload byte budget (Redis store)', () => {
  it('runs the reservation script on a rate-limit key with the bytes, budget and window', async () => {
    process.env.LOBBYFORGE_RATE_LIMIT_STORE = 'redis';
    const calls: unknown[][] = [];
    h.evalImpl = async (...args) => {
      calls.push(args);
      return [1, 4096, UPLOAD_BUDGET_WINDOW_MS];
    };
    expect(await reserveUploadBytes(req(), 4096)).toMatchObject({ ok: true, usedBytes: 4096 });
    const [, numKeys, key, bytes, budget, windowMs] = calls[0]!;
    expect(numKeys).toBe(1);
    expect(String(key)).toMatch(/^lf:[a-z]+:rate-limit:upload-bytes:[0-9a-f]{32}$/);
    // The raw address never lands in Redis.
    expect(String(key)).not.toContain('203.0.113.5');
    expect([bytes, budget, windowMs]).toEqual(['4096', String(UPLOAD_BYTES_PER_ADDRESS), String(UPLOAD_BUDGET_WINDOW_MS)]);
  });

  it('maps a refused script answer to 429 with the remaining window', async () => {
    process.env.LOBBYFORGE_RATE_LIMIT_STORE = 'redis';
    h.evalImpl = async () => [0, UPLOAD_BYTES_PER_ADDRESS, 3_600_000];
    const decision = await reserveUploadBytes(req(), 10);
    expect(decision).toMatchObject({ ok: false, reason: 'exhausted', retryAfterSeconds: 3600 });
  });

  it('fails CLOSED in production when Redis is unavailable', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    h.evalImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const refused = await consumeUploadBudget(req(), 10);
    expect(refused?.status).toBe(429);
    expect(await refused?.json()).toMatchObject({ code: 'rate_limited' });
  });

  it('falls back to memory outside production when Redis is unavailable', async () => {
    process.env.LOBBYFORGE_RATE_LIMIT_STORE = 'redis';
    h.evalImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect((await reserveUploadBytes(req(), 10)).ok).toBe(true);
  });
});
