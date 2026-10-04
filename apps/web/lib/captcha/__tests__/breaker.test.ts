/**
 * The external-provider breaker and the lazy reachability probe
 * (docs/CAPTCHA.md §5): 3 consecutive failures open it for 5 minutes, a
 * failed probe or a refused secret opens it at once, a success resets the
 * count, the probe runs at most once per 60 s, and Redis trouble falls back
 * to memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { probeSiteverify, redis } = vi.hoisted(() => ({
  probeSiteverify: vi.fn(),
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn(), eval: vi.fn() },
}));
vi.mock('../providers', () => ({ probeSiteverify }));
vi.mock('@/lib/redis', () => ({ redis }));

import {
  BREAKER_OPEN_MS,
  getBreakerState,
  lastProbe,
  maybeProbe,
  openBreaker,
  recordProviderFailure,
  recordProviderSuccess,
  resetBreaker,
  runProbe,
} from '../breaker';
import { resetCaptchaMemoryForTests } from '../store';

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_RATE_LIMIT_STORE', '');
  resetCaptchaMemoryForTests();
  probeSiteverify.mockReset();
  for (const fn of Object.values(redis)) fn.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('breaker', () => {
  it('opens after 3 consecutive failures, for 5 minutes', async () => {
    await recordProviderFailure('turnstile');
    await recordProviderFailure('turnstile');
    expect((await getBreakerState('turnstile')).open).toBe(false);
    await recordProviderFailure('turnstile');
    const state = await getBreakerState('turnstile');
    expect(state).toMatchObject({ open: true, reason: 'failures' });
    expect(state.until! - Date.now()).toBeGreaterThan(BREAKER_OPEN_MS - 1_000);
    expect(BREAKER_OPEN_MS).toBe(5 * 60_000);
    // Per provider.
    expect((await getBreakerState('recaptcha')).open).toBe(false);
    // Closed again once the 5 minutes are over.
    expect((await getBreakerState('turnstile', Date.now() + BREAKER_OPEN_MS + 1)).open).toBe(false);
  });

  it('a usable answer resets the consecutive count', async () => {
    await recordProviderFailure('recaptcha');
    await recordProviderFailure('recaptcha');
    await recordProviderSuccess('recaptcha');
    await recordProviderFailure('recaptcha');
    await recordProviderFailure('recaptcha');
    expect((await getBreakerState('recaptcha')).open).toBe(false);
  });

  it('resetBreaker closes it (after the admin saves new keys)', async () => {
    await openBreaker('turnstile', 'bad_secret');
    expect((await getBreakerState('turnstile')).reason).toBe('bad_secret');
    await resetBreaker('turnstile');
    expect((await getBreakerState('turnstile')).open).toBe(false);
  });

  it('production: shared through Redis, with the memory copy when Redis fails', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    redis.set.mockResolvedValue('OK');
    await openBreaker('turnstile', 'probe');
    const [key, value, px, ttl] = redis.set.mock.calls[0]!;
    expect(key).toBe('lf:production:captcha:breaker:turnstile');
    expect(JSON.parse(value as string)).toMatchObject({ reason: 'probe' });
    expect([px, ttl]).toEqual(['PX', BREAKER_OPEN_MS]);

    redis.get.mockResolvedValueOnce(value);
    expect((await getBreakerState('turnstile')).open).toBe(true);
    redis.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await getBreakerState('turnstile')).open).toBe(true); // memory copy
    redis.get.mockResolvedValueOnce(null);
    expect((await getBreakerState('turnstile')).open).toBe(false); // Redis is the shared truth

    redis.eval.mockRejectedValue(new Error('ECONNREFUSED'));
    redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    await resetBreaker('recaptcha');
    for (let i = 0; i < 3; i += 1) await recordProviderFailure('recaptcha');
    expect((await getBreakerState('recaptcha')).open).toBe(true);
  });
});

describe('reachability probe', () => {
  it('a failed probe opens the breaker; a refused secret too; a good one resets the failures', async () => {
    probeSiteverify.mockResolvedValueOnce('unreachable');
    expect(await runProbe('turnstile', 'secret-a')).toBe('unreachable');
    expect(await getBreakerState('turnstile')).toMatchObject({ open: true, reason: 'probe' });

    probeSiteverify.mockResolvedValueOnce('bad_secret');
    expect(await runProbe('recaptcha', 'secret-b')).toBe('bad_secret');
    expect(await getBreakerState('recaptcha')).toMatchObject({ open: true, reason: 'bad_secret' });

    await resetBreaker('turnstile');
    await recordProviderFailure('turnstile');
    await recordProviderFailure('turnstile');
    probeSiteverify.mockResolvedValueOnce('ok');
    await runProbe('turnstile', 'secret-a');
    await recordProviderFailure('turnstile');
    expect((await getBreakerState('turnstile')).open).toBe(false);
    expect(await lastProbe('turnstile', 'secret-a')).toMatchObject({ result: 'ok' });
    expect(await lastProbe('turnstile', 'another-secret')).toBeNull();
  });

  it('runs at most once per 60 s per provider and secret', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    probeSiteverify.mockResolvedValue('ok');
    const first = await maybeProbe('turnstile', 'secret');
    expect(first).not.toBeNull();
    expect(await first!.probe).toBe('ok');
    expect(await maybeProbe('turnstile', 'secret')).toBeNull();
    // Another secret (the admin just saved new keys) is probed straight away.
    expect(await maybeProbe('turnstile', 'new-secret')).not.toBeNull();
    vi.setSystemTime(Date.now() + 61_000);
    expect(await maybeProbe('turnstile', 'secret')).not.toBeNull();
    expect(probeSiteverify).toHaveBeenCalledTimes(3);
  });

  it('never throws, even when the probe itself blows up', async () => {
    probeSiteverify.mockRejectedValue(new Error('boom'));
    const started = await maybeProbe('recaptcha', 'secret');
    expect(await started!.probe).toBe('unreachable');
  });
});
