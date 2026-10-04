/**
 * Settings resolution with environment overrides (docs/CAPTCHA.md §3), the
 * per-process cache, the CSP provider lookup's fallbacks (§9), and the
 * Doctor checks (§8).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertLevel } from '@lobbyforge/core';

const { getInstanceCaptchaSettings } = vi.hoisted(() => ({ getInstanceCaptchaSettings: vi.fn() }));
vi.mock('@lobbyforge/db', () => ({ getInstanceCaptchaSettings }));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));

import { buildCaptchaChecks, type CaptchaDoctorFacts } from '../doctor';
import { captchaCspSourcesFor, cspCaptchaProvider, isCaptchaPagePath, CSP_LOOKUP_TIMEOUT_MS, CSP_STALE_REFRESH_WAIT_MS } from '../csp';
import { encryptCaptchaSecret } from '../secret';
import { externalProviderConfigured, invalidateCaptchaSettingsCache, resolveCaptchaSettings } from '../settings';
import { DEFAULT_CAPTCHA_OPTIONS, DEFAULT_CAPTCHA_SURFACES } from '../types';

function row(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: 'self-host',
    provider: 'altcha',
    surfaces: { ...DEFAULT_CAPTCHA_SURFACES },
    siteKey: null,
    secretEncrypted: null,
    options: {},
    attackMode: false,
    updatedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'm'.repeat(40));
  for (const name of ['LOBBYFORGE_CAPTCHA_PROVIDER', 'LOBBYFORGE_CAPTCHA_SITE_KEY', 'LOBBYFORGE_CAPTCHA_SECRET_KEY']) vi.stubEnv(name, '');
  getInstanceCaptchaSettings.mockReset().mockResolvedValue(row());
  invalidateCaptchaSettingsCache();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('resolveCaptchaSettings', () => {
  it('fills the defaults and tolerates junk in the stored JSON', async () => {
    getInstanceCaptchaSettings.mockResolvedValue(
      row({ surfaces: { register: 'maybe', login: 'always' }, options: { recaptchaMinScore: 7, loginFailureThreshold: 5, extra: true } })
    );
    const settings = await resolveCaptchaSettings();
    expect(settings.surfaces).toEqual({ ...DEFAULT_CAPTCHA_SURFACES, login: 'always' });
    expect(settings.options).toEqual({ ...DEFAULT_CAPTCHA_OPTIONS, loginFailureThreshold: 5 });
    expect(settings).toMatchObject({ provider: 'altcha', secretState: 'unset', secretKey: null, secretHint: null, loaded: true });
    expect(settings.locked).toEqual({ provider: false, siteKey: false, secretKey: false });
  });

  it('decrypts the stored secret; reports one it cannot decrypt', async () => {
    getInstanceCaptchaSettings.mockResolvedValue(row({ provider: 'turnstile', siteKey: 'site', secretEncrypted: encryptCaptchaSecret('0x4AAAAAAAsecretWXYZ') }));
    let settings = await resolveCaptchaSettings({ fresh: true });
    expect(settings).toMatchObject({ secretKey: '0x4AAAAAAAsecretWXYZ', secretState: 'ok', secretHint: '…WXYZ' });
    expect(externalProviderConfigured(settings)).toBe(true);
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'n'.repeat(40));
    settings = await resolveCaptchaSettings({ fresh: true });
    expect(settings).toMatchObject({ secretKey: null, secretState: 'undecryptable', secretHint: null });
    expect(externalProviderConfigured(settings)).toBe(false);
  });

  it('the environment wins and locks the fields it sets', async () => {
    getInstanceCaptchaSettings.mockResolvedValue(row({ provider: 'altcha', siteKey: 'stored-site' }));
    vi.stubEnv('LOBBYFORGE_CAPTCHA_PROVIDER', ' Turnstile ');
    vi.stubEnv('LOBBYFORGE_CAPTCHA_SITE_KEY', 'env-site');
    vi.stubEnv('LOBBYFORGE_CAPTCHA_SECRET_KEY', 'env-secret-1234567890');
    const settings = await resolveCaptchaSettings({ fresh: true });
    expect(settings).toMatchObject({ provider: 'turnstile', siteKey: 'env-site', secretKey: 'env-secret-1234567890', secretState: 'ok' });
    expect(settings.locked).toEqual({ provider: true, siteKey: true, secretKey: true });
    expect(settings.stored.provider).toBe('altcha');
  });

  it('ignores an unknown provider value in the environment (Doctor reports it)', async () => {
    vi.stubEnv('LOBBYFORGE_CAPTCHA_PROVIDER', 'hcaptcha');
    const settings = await resolveCaptchaSettings({ fresh: true });
    expect(settings.provider).toBe('altcha');
    expect(settings.locked.provider).toBe(false);
    expect(settings.env.invalidProvider).toBe('hcaptcha');
  });

  it('caches for a few seconds, until invalidated', async () => {
    await resolveCaptchaSettings();
    await resolveCaptchaSettings();
    expect(getInstanceCaptchaSettings).toHaveBeenCalledTimes(1);
    invalidateCaptchaSettingsCache();
    await resolveCaptchaSettings();
    expect(getInstanceCaptchaSettings).toHaveBeenCalledTimes(2);
    await resolveCaptchaSettings({ fresh: true });
    expect(getInstanceCaptchaSettings).toHaveBeenCalledTimes(3);
  });

  it('a database error means the protective defaults, cached for 3 s, logged once a minute — never "off"', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getInstanceCaptchaSettings.mockRejectedValue(new Error('connection refused'));
    const settings = await resolveCaptchaSettings();
    expect(settings).toMatchObject({ provider: 'altcha', loaded: false, surfaces: DEFAULT_CAPTCHA_SURFACES });
    await resolveCaptchaSettings();
    expect(getInstanceCaptchaSettings).toHaveBeenCalledTimes(1); // the failure is cached
    vi.setSystemTime(Date.now() + 3_001);
    await resolveCaptchaSettings();
    expect(getInstanceCaptchaSettings).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1); // throttled
    vi.setSystemTime(Date.now() + 60_000);
    await resolveCaptchaSettings();
    expect(error).toHaveBeenCalledTimes(2);
    // The admin API's fresh reads are never served from the cache.
    await resolveCaptchaSettings({ fresh: true });
    expect(getInstanceCaptchaSettings).toHaveBeenCalledTimes(4);
  });

  it('a read that started before a save cannot put the old values back (generation counter)', async () => {
    let finishOld!: (value: unknown) => void;
    getInstanceCaptchaSettings.mockReturnValueOnce(new Promise((resolve) => (finishOld = resolve)));
    const slow = resolveCaptchaSettings();
    // The admin saves (new provider) and invalidates while that read is running.
    invalidateCaptchaSettingsCache();
    getInstanceCaptchaSettings.mockResolvedValue(row({ provider: 'none' }));
    finishOld(row({ provider: 'altcha' }));
    expect((await slow).provider).toBe('altcha'); // its own caller gets what it read…
    expect((await resolveCaptchaSettings()).provider).toBe('none'); // …but the cache does not keep it
  });
});

describe('CSP provider lookup', () => {
  it('tells pages from API routes and static files', () => {
    for (const path of ['/', '/home', '/login', '/join/ABCD', '/room/r1', '/settings/profile', '/admin/settings/authentication', '/login/']) {
      expect(isCaptchaPagePath(path), path).toBe(true);
    }
    for (const path of ['/api', '/api/auth/login', '/_next/static/chunk.js', '/favicon.ico', '/manifest.webmanifest', '/brand/logo.svg']) {
      expect(isCaptchaPagePath(path), path).toBe(false);
    }
  });

  it('stays cheap on every page: concurrent and repeated lookups share one database read per 5 s', async () => {
    getInstanceCaptchaSettings.mockResolvedValue(row({ provider: 'turnstile', siteKey: 'site', secretEncrypted: encryptCaptchaSecret('secret-secret') }));
    const results = await Promise.all(Array.from({ length: 25 }, () => cspCaptchaProvider()));
    expect(new Set(results)).toEqual(new Set(['turnstile']));
    for (let i = 0; i < 25; i += 1) await cspCaptchaProvider();
    expect(getInstanceCaptchaSettings).toHaveBeenCalledTimes(1);
  });

  it('only an external provider with both keys needs origins', async () => {
    expect(await cspCaptchaProvider()).toBeNull();
    getInstanceCaptchaSettings.mockResolvedValue(row({ provider: 'recaptcha', siteKey: 'site', secretEncrypted: encryptCaptchaSecret('secret-secret') }));
    invalidateCaptchaSettingsCache();
    expect(await cspCaptchaProvider()).toBe('recaptcha');
    expect(captchaCspSourcesFor('recaptcha').frame).toContain('https://recaptcha.google.com/recaptcha/');
    expect(captchaCspSourcesFor('altcha')).toEqual({ script: [], frame: [], connect: [] });
  });

  it('a stale value is refreshed before the page goes out: a change saved in another process shows on the next page', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    getInstanceCaptchaSettings.mockResolvedValue(row({ provider: 'turnstile', siteKey: 'site', secretEncrypted: encryptCaptchaSecret('secret-secret') }));
    expect(await cspCaptchaProvider()).toBe('turnstile');
    // Another process switched back to ALTCHA (this one's cache was never invalidated).
    getInstanceCaptchaSettings.mockResolvedValue(row({ provider: 'altcha' }));
    vi.setSystemTime(Date.now() + 6_000);
    expect(await cspCaptchaProvider()).toBeNull();
    expect(getInstanceCaptchaSettings).toHaveBeenCalledTimes(2);
  });

  it('with a hung database a stale page waits at most the short cap, then pages stop waiting for 5 s', async () => {
    vi.useFakeTimers();
    getInstanceCaptchaSettings.mockResolvedValue(row({ provider: 'turnstile', siteKey: 'site', secretEncrypted: encryptCaptchaSecret('secret-secret') }));
    expect(await cspCaptchaProvider()).toBe('turnstile');
    vi.setSystemTime(Date.now() + 6_000);
    getInstanceCaptchaSettings.mockReturnValue(new Promise(() => undefined));
    const pending = cspCaptchaProvider();
    await vi.advanceTimersByTimeAsync(CSP_STALE_REFRESH_WAIT_MS + 1);
    expect(await pending).toBe('turnstile'); // the last known value
    expect(CSP_STALE_REFRESH_WAIT_MS).toBeLessThan(CSP_LOOKUP_TIMEOUT_MS);
    // Inside the back-off window: answered at once, no timer needed, and they
    // share the one refresh that is still running.
    expect(await cspCaptchaProvider()).toBe('turnstile');
    expect(await cspCaptchaProvider()).toBe('turnstile');
    expect(getInstanceCaptchaSettings).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_001);
  });

  it('the very first lookup waits at most the cap, then pages stop waiting for 5 s (environment fallback)', async () => {
    vi.useFakeTimers();
    getInstanceCaptchaSettings.mockReturnValue(new Promise(() => undefined));
    const pending = cspCaptchaProvider();
    await vi.advanceTimersByTimeAsync(CSP_LOOKUP_TIMEOUT_MS + 1);
    expect(await pending).toBeNull();

    vi.stubEnv('LOBBYFORGE_CAPTCHA_PROVIDER', 'turnstile');
    vi.stubEnv('LOBBYFORGE_CAPTCHA_SITE_KEY', 'site');
    vi.stubEnv('LOBBYFORGE_CAPTCHA_SECRET_KEY', 'secret');
    // Inside the back-off window: answered at once, no timer needed.
    expect(await cspCaptchaProvider()).toBe('turnstile');
    vi.advanceTimersByTime(5_001);
  });
});

describe('Doctor checks', () => {
  const base: CaptchaDoctorFacts = {
    provider: 'altcha',
    siteKeySet: false,
    secretState: 'unset',
    siteKeyIsTest: false,
    secretIsTest: false,
    invalidEnvProvider: null,
    settingsLoaded: true,
    probe: null,
    breaker: null,
    badSecretSeen: false,
    production: true,
    redisReachable: true,
  };
  const ids = (facts: Partial<CaptchaDoctorFacts>) => buildCaptchaChecks({ ...base, ...facts }).map((c) => `${c.id}:${c.ok ? 'ok' : c.level}`);

  it('all good: one info line naming the provider', () => {
    expect(ids({})).toEqual(['captcha:ok']);
    expect(buildCaptchaChecks(base)[0]!.message).toContain('ALTCHA');
  });

  it('an external provider with a key missing', () => {
    expect(ids({ provider: 'turnstile', siteKeySet: true })).toEqual(['captcha_keys:warning']);
    expect(buildCaptchaChecks({ ...base, provider: 'turnstile' })[0]!.message).toContain('site key and secret key');
  });

  it('a secret that cannot be decrypted', () => {
    expect(ids({ provider: 'recaptcha', siteKeySet: true, secretState: 'undecryptable' })).toEqual(['captcha_secret:warning']);
  });

  it('siteverify: bad secret or unreachable (probe); for reCAPTCHA also a bad secret seen on a real verification', () => {
    const ready = { provider: 'turnstile' as const, siteKeySet: true, secretState: 'ok' as const };
    expect(ids({ ...ready, probe: 'bad_secret' })).toEqual(['captcha_siteverify:warning']);
    expect(ids({ ...ready, probe: 'unreachable' })).toEqual(['captcha_siteverify:warning']);
    expect(ids({ ...ready, probe: 'ok' })).toEqual(['captcha:ok']);
    // Turnstile's probe is authoritative: a real-verification answer alone is not reported.
    expect(ids({ ...ready, probe: 'ok', badSecretSeen: true })).toEqual(['captcha:ok']);
    // reCAPTCHA's probe cannot tell, so the real-verification answer is what Doctor shows.
    expect(ids({ ...ready, provider: 'recaptcha', probe: 'ok', badSecretSeen: true })).toEqual(['captcha_siteverify:warning']);
  });

  it('test keys in production (not in development)', () => {
    const ready = { provider: 'turnstile' as const, siteKeySet: true, secretState: 'ok' as const, probe: 'ok' as const };
    expect(ids({ ...ready, secretIsTest: true })).toEqual(['captcha_test_keys:warning']);
    expect(ids({ ...ready, siteKeyIsTest: true, production: false })).toEqual(['captcha:ok']);
  });

  it('Redis down in production: ALTCHA cannot block replays (critical)', () => {
    expect(ids({ redisReachable: false })).toEqual(['captcha_replay_store:critical']);
    expect(ids({ redisReachable: false, production: false })).toEqual(['captcha:ok']);
    expect(ids({ provider: 'none', redisReachable: false })).toEqual(['captcha:ok']);
  });

  it('an unknown env provider and unreadable settings', () => {
    expect(ids({ invalidEnvProvider: 'hcaptcha', settingsLoaded: false })).toEqual(['captcha_env:warning', 'captcha_settings:warning']);
  });

  it('every check sits in the services category', () => {
    const checks = buildCaptchaChecks({ ...base, provider: 'turnstile', redisReachable: false, invalidEnvProvider: 'x' });
    expect(new Set(checks.map((c) => c.category))).toEqual(new Set(['services']));
    expect(checks.find((c) => c.id === 'captcha_replay_store')?.level).toBe(AlertLevel.CRITICAL);
  });
});
