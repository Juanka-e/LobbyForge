/**
 * Address-aware limits (docs/CAPTCHA.md §4.2, §7): a bucket per client
 * address; with no trusted proxy (every client "unknown") one much larger
 * instance-wide backstop instead of a tiny bucket everyone shares.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redis } = vi.hoisted(() => ({ redis: { get: vi.fn(), pttl: vi.fn(), eval: vi.fn() } }));
vi.mock('@/lib/redis', () => ({ redis }));

import { CHALLENGE_LIMIT, CONFIG_LIMIT, NEW_GUEST_LIMIT, hitAddressLimit, peekAddressLimit } from '../limits';
import { resetCaptchaMemoryForTests } from '../store';

function request(ip?: string): Request {
  return new Request('https://community.example/api/auth/guest', { headers: ip ? { 'x-forwarded-for': ip } : {} });
}

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_RATE_LIMIT_STORE', '');
  vi.stubEnv('LOBBYFORGE_TRUSTED_PROXY', 'x-forwarded-for');
  resetCaptchaMemoryForTests();
  for (const fn of Object.values(redis)) fn.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe('address-aware limits', () => {
  it('the numbers: 10/h new guests, 30/min challenges, 120/min config per address; 200/h, 600/min, 1200/min without a trusted proxy', () => {
    expect(NEW_GUEST_LIMIT).toMatchObject({ windowMs: 3_600_000, perAddress: 10, unknownBackstop: 200 });
    expect(CHALLENGE_LIMIT).toMatchObject({ windowMs: 60_000, perAddress: 30, unknownBackstop: 600 });
    expect(CONFIG_LIMIT).toMatchObject({ windowMs: 60_000, perAddress: 120, unknownBackstop: 1200 });
  });

  it('counts per client address: one address full, the next one unaffected', async () => {
    for (let i = 0; i < 10; i += 1) expect(await hitAddressLimit(request('198.51.100.1'), NEW_GUEST_LIMIT)).toBeNull();
    const refused = await hitAddressLimit(request('198.51.100.1'), NEW_GUEST_LIMIT);
    expect(refused?.status).toBe(429);
    expect(await refused!.json()).toMatchObject({ error: 'Rate limit exceeded' });
    expect(Number(refused!.headers.get('retry-after'))).toBeGreaterThan(3_500);
    expect(await hitAddressLimit(request('198.51.100.2'), NEW_GUEST_LIMIT)).toBeNull();
  });

  it('peek reads without counting, and refuses once the bucket is full', async () => {
    for (let i = 0; i < 20; i += 1) expect(await peekAddressLimit(request('198.51.100.3'), NEW_GUEST_LIMIT)).toBeNull();
    for (let i = 0; i < 10; i += 1) await hitAddressLimit(request('198.51.100.3'), NEW_GUEST_LIMIT);
    expect((await peekAddressLimit(request('198.51.100.3'), NEW_GUEST_LIMIT))?.status).toBe(429);
  });

  it('unknown addresses (no trusted proxy) share a large backstop, not the per-address bucket', async () => {
    vi.stubEnv('LOBBYFORGE_TRUSTED_PROXY', '');
    // A LAN party: 30 people, each creating a guest — far past 10, well within 200.
    for (let i = 0; i < 30; i += 1) expect(await hitAddressLimit(request(`10.0.0.${i}`), NEW_GUEST_LIMIT)).toBeNull();
    for (let i = 30; i < 200; i += 1) await hitAddressLimit(request(), NEW_GUEST_LIMIT);
    expect((await hitAddressLimit(request(), NEW_GUEST_LIMIT))?.status).toBe(429);
    // Challenges have their own backstop.
    expect(await hitAddressLimit(request(), CHALLENGE_LIMIT)).toBeNull();
  });

  it('production: Redis (INCR with a window, GET/PTTL to peek), keys hold a hash of the address', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    redis.eval.mockResolvedValue([3, 59_000]);
    expect(await hitAddressLimit(request('198.51.100.9'), CHALLENGE_LIMIT)).toBeNull();
    const [, , key, windowMs] = redis.eval.mock.calls[0]!;
    expect(String(key)).toMatch(/^lf:production:rate-limit:captcha-challenge:[0-9a-f]{32}$/);
    expect(String(key)).not.toContain('198.51.100.9');
    expect(windowMs).toBe('60000');
    redis.get.mockResolvedValue('30');
    redis.pttl.mockResolvedValue(12_000);
    const refused = await peekAddressLimit(request('198.51.100.9'), CHALLENGE_LIMIT);
    expect(refused?.status).toBe(429);
    expect(refused!.headers.get('retry-after')).toBe('12');
  });

  it('production without Redis fails closed', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    redis.eval.mockRejectedValue(new Error('ECONNREFUSED'));
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    expect((await hitAddressLimit(request('198.51.100.9'), NEW_GUEST_LIMIT))?.status).toBe(429);
    expect((await peekAddressLimit(request('198.51.100.9'), NEW_GUEST_LIMIT))?.status).toBe(429);
  });
});
