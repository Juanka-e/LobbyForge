/**
 * verifyCaptcha, the route guards and the public config (docs/CAPTCHA.md
 * §2, §4, §5, §7) over the real modules: settings (stored row mocked),
 * ALTCHA solved with altcha-lib, the breaker, the sign-in signals and the
 * per-account counter — only the database row and the network are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';

const { stored } = vi.hoisted(() => ({
  stored: {
    current: {} as Record<string, unknown>,
    registrationMode: 'open' as string,
  },
}));
vi.mock('@lobbyforge/db', () => ({
  getInstanceCaptchaSettings: async () => ({ ...stored.current }),
  getEffectiveInstanceAccessSettings: async () => ({ registrationMode: stored.registrationMode }),
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));

import { ALTCHA_DIFFICULTY, createAltchaChallenge } from '../altcha';
import { getBreakerState, lastBadSecretSeen } from '../breaker';
import { issueFormToken } from '../form';
import { buildPublicCaptchaConfig, captchaSurfaceRequired, guardCaptchaSurface, guardSignInCaptcha } from '../guard';
import { setSiteverifyTransportForTests } from '../providers';
import { encryptCaptchaSecret } from '../secret';
import { invalidateCaptchaSettingsCache, resolveCaptchaSettings } from '../settings';
import { recordSignInFailure } from '../signals';
import { resetCaptchaMemoryForTests } from '../store';
import { verifyCaptcha } from '../verify';
import { beginSignInAttempt, resetAccountAttemptsForTests } from '@/lib/auth-throttle';
import type { CaptchaSurface } from '../types';

const SESSION_SECRET = 'q'.repeat(48);
const REAL_NORMAL = { ...ALTCHA_DIFFICULTY.normal };
const transport = vi.fn();

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: 'self-host',
    provider: 'altcha',
    surfaces: { register: 'on', invite_register: 'off', guest: 'on', login: 'adaptive' },
    siteKey: null,
    secretEncrypted: null,
    options: {},
    attackMode: false,
    updatedAt: null,
    ...overrides,
  };
}

function useSettings(overrides: Record<string, unknown> = {}): void {
  stored.current = storedRow(overrides);
  invalidateCaptchaSettingsCache();
}

function turnstile(overrides: Record<string, unknown> = {}): void {
  useSettings({ provider: 'turnstile', siteKey: '0x4AAAAAAAsite', secretEncrypted: encryptCaptchaSecret('0x4AAAAAAAsecretsecretsecret'), ...overrides });
}

async function altchaToken(surface: CaptchaSurface): Promise<string> {
  const challenge = await createAltchaChallenge(surface);
  const solution = await solveChallenge({ challenge, deriveKey });
  return Buffer.from(JSON.stringify({ challenge, solution })).toString('base64');
}

function request(ip = '198.51.100.7'): Request {
  return new Request('https://community.example/api/auth/login', { method: 'POST', headers: { 'x-forwarded-for': ip } });
}

let formTokenSeq = 0;
// A distinct token every call (form tokens are single use).
const formToken = (surface: 'register' | 'invite_register' | 'guest') => issueFormToken(surface, Date.now() - 10_000 - (formTokenSeq += 1));

async function refusal(response: Response | null): Promise<string | null> {
  if (!response) return null;
  expect(response.status).toBe(400);
  return ((await response.json()) as { error: string }).error;
}

const siteverifyOk = (action: string) => ({ status: 200, body: { success: true, hostname: 'community.example', action } });

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SESSION_SECRET);
  vi.stubEnv('LOBBYFORGE_TRUSTED_PROXY', 'x-forwarded-for');
  vi.stubEnv('LOBBYFORGE_RATE_LIMIT_STORE', '');
  vi.stubEnv('LOBBYFORGE_CAPTCHA_PROVIDER', '');
  vi.stubEnv('LOBBYFORGE_CAPTCHA_SITE_KEY', '');
  vi.stubEnv('LOBBYFORGE_CAPTCHA_SECRET_KEY', '');
  ALTCHA_DIFFICULTY.normal = { cost: 10, counterMin: 5, counterMax: 40 };
  resetCaptchaMemoryForTests();
  resetAccountAttemptsForTests();
  transport.mockReset();
  setSiteverifyTransportForTests(transport);
  useSettings();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  ALTCHA_DIFFICULTY.normal = { ...REAL_NORMAL };
  setSiteverifyTransportForTests(null);
  vi.unstubAllEnvs();
});

describe('verifyCaptcha', () => {
  it('provider none: everything passes', async () => {
    useSettings({ provider: 'none' });
    expect(await verifyCaptcha({ surface: 'register', token: null, req: request() })).toBe('ok');
  });

  it('ALTCHA: missing, a good token, and no external token accepted instead', async () => {
    expect(await verifyCaptcha({ surface: 'register', token: '', req: request() })).toBe('missing');
    const token = await altchaToken('register');
    expect(await verifyCaptcha({ surface: 'register', token, provider: 'turnstile', req: request() })).toBe('invalid');
    expect(await verifyCaptcha({ surface: 'register', token, provider: 'altcha', req: request() })).toBe('ok');
    expect(await verifyCaptcha({ surface: 'register', token, req: request() })).toBe('duplicate');
  });

  it('a healthy external provider: only its tokens are accepted — a bot cannot pick ALTCHA', async () => {
    turnstile();
    transport.mockResolvedValue(siteverifyOk('register'));
    expect(await verifyCaptcha({ surface: 'register', token: 'cf-token', provider: 'turnstile', req: request() })).toBe('ok');
    expect(await verifyCaptcha({ surface: 'register', token: await altchaToken('register'), provider: 'altcha', req: request() })).toBe('invalid');
    const form = new URLSearchParams(String(transport.mock.calls[0]![1]));
    expect(form.get('secret')).toBe('0x4AAAAAAAsecretsecretsecret');
    expect(form.get('remoteip')).toBe('198.51.100.7');
  });

  it('three network failures open the breaker; then ALTCHA is accepted and the external token says "unavailable"', async () => {
    turnstile();
    transport.mockRejectedValue(new Error('ETIMEDOUT'));
    for (let i = 0; i < 3; i += 1) {
      expect(await verifyCaptcha({ surface: 'guest', token: 'cf-token', provider: 'turnstile', req: request() })).toBe('unavailable');
    }
    expect((await getBreakerState('turnstile')).open).toBe(true);
    expect(await verifyCaptcha({ surface: 'guest', token: 'cf-token', provider: 'turnstile', req: request() })).toBe('unavailable');
    expect(await verifyCaptcha({ surface: 'guest', token: await altchaToken('guest'), provider: 'altcha', req: request() })).toBe('ok');
  });

  it('a "bad secret" answer to a REAL verification never opens the breaker by itself (a foreign token can draw it)', async () => {
    turnstile();
    // The attacker's token answers "invalid secret"; the dummy-token probe (only the real secret matters) says fine.
    transport.mockImplementation(async (_url: string, form: URLSearchParams) =>
      form.get('response') === 'lobbyforge-reachability-probe'
        ? { status: 200, body: { success: false, 'error-codes': ['invalid-input-response'] } }
        : { status: 200, body: { success: false, 'error-codes': ['invalid-input-secret'] } }
    );
    for (let i = 0; i < 5; i += 1) {
      expect(await verifyCaptcha({ surface: 'register', token: `attacker-${i}`, provider: 'turnstile', req: request() })).toBe('invalid');
    }
    await vi.waitFor(() =>
      expect(transport.mock.calls.some((call) => (call[1] as URLSearchParams).get('response') === 'lobbyforge-reachability-probe')).toBe(true)
    );
    expect((await getBreakerState('turnstile')).open).toBe(false);
    expect(await lastBadSecretSeen('turnstile')).not.toBeNull();
  });

  it('Turnstile: when the probe confirms the secret really is wrong, IT opens the breaker', async () => {
    turnstile();
    transport.mockResolvedValue({ status: 200, body: { success: false, 'error-codes': ['invalid-input-secret'] } });
    expect(await verifyCaptcha({ surface: 'register', token: 'cf-token', provider: 'turnstile', req: request() })).toBe('invalid');
    await vi.waitFor(async () => expect(await getBreakerState('turnstile')).toMatchObject({ open: true, reason: 'bad_secret' }));
  });

  it('reCAPTCHA: a "bad secret" answer is only recorded (Doctor), no probe and no breaker', async () => {
    useSettings({ provider: 'recaptcha', siteKey: 'site', secretEncrypted: encryptCaptchaSecret('6LcREALsecretsecret') });
    transport.mockResolvedValue({ status: 200, body: { success: false, 'error-codes': ['invalid-input-secret'] } });
    expect(await verifyCaptcha({ surface: 'login', token: 'g-token', provider: 'recaptcha', req: request() })).toBe('invalid');
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await getBreakerState('recaptcha')).open).toBe(false);
    expect(await lastBadSecretSeen('recaptcha')).not.toBeNull();
  });

  it('misconfigured external provider (no secret, or one that cannot be decrypted) behaves like an open breaker', async () => {
    turnstile({ secretEncrypted: null });
    expect(await verifyCaptcha({ surface: 'register', token: await altchaToken('register'), provider: 'altcha', req: request() })).toBe('ok');
    turnstile({ secretEncrypted: 'v1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA' });
    expect(await verifyCaptcha({ surface: 'register', token: await altchaToken('register'), provider: 'altcha', req: request() })).toBe('ok');
    expect(transport).not.toHaveBeenCalled();
  });

  it('without a session secret ALTCHA is misconfigured', async () => {
    const token = await altchaToken('login');
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', '');
    expect(await verifyCaptcha({ surface: 'login', token, req: request() })).toBe('misconfigured');
  });

  it('the environment wins: LOBBYFORGE_CAPTCHA_PROVIDER=none is the emergency switch', async () => {
    turnstile();
    vi.stubEnv('LOBBYFORGE_CAPTCHA_PROVIDER', 'none');
    invalidateCaptchaSettingsCache();
    expect(await verifyCaptcha({ surface: 'register', token: null, req: request() })).toBe('ok');
  });
});

describe('guardCaptchaSurface (sign-up, new guests)', () => {
  it('a filled honeypot is refused, protection on or off', async () => {
    expect(await refusal(await guardCaptchaSurface(request(), { website: 'http://spam' }, 'register'))).toBe('form_rejected');
    useSettings({ provider: 'none' });
    expect(await refusal(await guardCaptchaSurface(request(), { website: 'x' }, 'guest'))).toBe('form_rejected');
  });

  it('an off surface lets the request through without token or form token', async () => {
    expect(await guardCaptchaSurface(request(), {}, 'invite_register', { registrationMode: 'invite_only' })).toBeNull();
    useSettings({ provider: 'none' });
    expect(await guardCaptchaSurface(request(), {}, 'register')).toBeNull();
  });

  it('no token → captcha_required (before the form token is looked at)', async () => {
    expect(await refusal(await guardCaptchaSurface(request(), {}, 'register'))).toBe('captcha_required');
    expect(await refusal(await guardCaptchaSurface(request(), { formToken: 'garbage' }, 'guest'))).toBe('captcha_required');
  });

  it('a token without a valid, old-enough form token → form_rejected', async () => {
    const token = await altchaToken('register');
    expect(await refusal(await guardCaptchaSurface(request(), { captchaToken: token }, 'register'))).toBe('form_rejected');
    const rushed = issueFormToken('register', Date.now() - 500);
    expect(await refusal(await guardCaptchaSurface(request(), { captchaToken: token, formToken: rushed }, 'register'))).toBe('form_rejected');
    expect(await refusal(await guardCaptchaSurface(request(), { captchaToken: token, formToken: formToken('guest') }, 'register'))).toBe('form_rejected');
  });

  it('a good token and form token pass; a bad, reused or other-surface token → captcha_invalid', async () => {
    const token = await altchaToken('guest');
    expect(await guardCaptchaSurface(request(), { captchaToken: token, captchaProvider: 'altcha', formToken: formToken('guest') }, 'guest')).toBeNull();
    expect(await refusal(await guardCaptchaSurface(request(), { captchaToken: token, formToken: formToken('guest') }, 'guest'))).toBe('captcha_invalid');
    const other = await altchaToken('guest');
    expect(await refusal(await guardCaptchaSurface(request(), { captchaToken: other, formToken: formToken('register') }, 'register'))).toBe('captcha_invalid');
    expect(await refusal(await guardCaptchaSurface(request(), { captchaToken: 'nope', formToken: formToken('register') }, 'register'))).toBe('captcha_invalid');
  });

  it('a form token is single use: burnt when the request succeeds, not when the challenge fails', async () => {
    const ft = formToken('register');
    expect(await refusal(await guardCaptchaSurface(request(), { captchaToken: 'bad', formToken: ft }, 'register'))).toBe('captcha_invalid');
    expect(await guardCaptchaSurface(request(), { captchaToken: await altchaToken('register'), formToken: ft }, 'register')).toBeNull();
    expect(await refusal(await guardCaptchaSurface(request(), { captchaToken: await altchaToken('register'), formToken: ft }, 'register'))).toBe('form_rejected');
  });

  it('production: the form token marker is a Redis SET NX — and without Redis the request is refused', async () => {
    const { redis } = await import('@/lib/redis');
    const set = vi.spyOn(redis, 'set');
    const token = await altchaToken('guest');
    const ft = formToken('guest');
    vi.stubEnv('NODE_ENV', 'production');
    set.mockResolvedValueOnce('OK' as never).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    // The ALTCHA marker goes through, the form token marker fails: fail closed.
    expect(await refusal(await guardCaptchaSurface(request(), { captchaToken: token, formToken: ft }, 'guest'))).toBe('captcha_unavailable');
    const [key, , px, ttl, nx] = set.mock.calls[1]!;
    expect(String(key)).toMatch(/^lf:production:captcha:form-used:[0-9a-f]{64}$/);
    expect([px, nx]).toEqual(['PX', 'NX']);
    expect(Number(ttl)).toBeGreaterThan(2 * 60 * 60_000 - 60_000);
    set.mockRestore();
  });

  it('an unreachable external provider → captcha_unavailable', async () => {
    turnstile();
    transport.mockRejectedValue(new Error('ECONNRESET'));
    expect(
      await refusal(await guardCaptchaSurface(request(), { captchaToken: 'cf', captchaProvider: 'turnstile', formToken: formToken('register') }, 'register'))
    ).toBe('captcha_unavailable');
  });
});

describe('invite sign-up can only ADD protection (§2)', () => {
  const surfaces = (register: string, invite: string) => ({ register, invite_register: invite, guest: 'on', login: 'adaptive' });

  it('open instance: an invite sign-up is challenged when register OR invite_register is on', async () => {
    const cases: Array<[string, string, boolean]> = [
      ['on', 'off', true], // the downgrade the review found: register on, invite off
      ['off', 'on', true],
      ['on', 'on', true],
      ['off', 'off', false],
    ];
    for (const [register, invite, expected] of cases) {
      useSettings({ surfaces: surfaces(register, invite) });
      const settings = await resolveCaptchaSettings();
      expect(captchaSurfaceRequired(settings, 'invite_register', 'open'), `${register}/${invite}`).toBe(expected);
      expect(captchaSurfaceRequired(settings, 'invite_register', null), `unknown mode ${register}/${invite}`).toBe(expected);
    }
  });

  it('invite-only instance: invite_register alone decides', async () => {
    useSettings({ surfaces: surfaces('on', 'off') });
    expect(captchaSurfaceRequired(await resolveCaptchaSettings(), 'invite_register', 'invite_only')).toBe(false);
    useSettings({ surfaces: surfaces('off', 'on') });
    expect(captchaSurfaceRequired(await resolveCaptchaSettings(), 'invite_register', 'invite_only')).toBe(true);
  });

  it('the guard refuses an invite sign-up without a token on an open instance with register on', async () => {
    useSettings({ surfaces: surfaces('on', 'off') });
    expect(await refusal(await guardCaptchaSurface(request(), {}, 'invite_register', { registrationMode: 'open' }))).toBe('captcha_required');
    expect(await guardCaptchaSurface(request(), {}, 'invite_register', { registrationMode: 'invite_only' })).toBeNull();
    const ok = await guardCaptchaSurface(
      request(),
      { captchaToken: await altchaToken('invite_register'), formToken: formToken('invite_register') },
      'invite_register',
      { registrationMode: 'open' }
    );
    expect(ok).toBeNull();
  });

  it('the public config of invite_register follows the same rule (it reads the registration mode)', async () => {
    useSettings({ surfaces: surfaces('on', 'off') });
    stored.registrationMode = 'open';
    expect(await buildPublicCaptchaConfig('invite_register')).toMatchObject({ required: true, mode: 'on' });
    stored.registrationMode = 'invite_only';
    expect(await buildPublicCaptchaConfig('invite_register')).toMatchObject({ required: false, mode: 'off' });
    stored.registrationMode = 'open';
  });
});

describe('guardSignInCaptcha (adaptive sign-in)', () => {
  const email = 'owner@example.com';
  const ctx = (overrides: Partial<{ email: string; hasDeviceClaim: boolean }> = {}) => ({ email, hasDeviceClaim: false, ...overrides });

  async function failAccount(times: number, address = email): Promise<void> {
    for (let i = 0; i < times; i += 1) await beginSignInAttempt({ email: address });
  }

  it('asks nothing of a quiet account', async () => {
    expect(await guardSignInCaptcha(request(), {}, ctx())).toBeNull();
  });

  it('asks after loginFailureThreshold failures on the account (default 3), then accepts a solved challenge', async () => {
    await failAccount(2);
    expect(await guardSignInCaptcha(request(), {}, ctx())).toBeNull();
    await failAccount(1);
    expect(await refusal(await guardSignInCaptcha(request(), {}, ctx()))).toBe('captcha_required');
    // Same answer for an unknown address with the same count: no enumeration.
    await failAccount(3, 'nobody@example.com');
    expect(await refusal(await guardSignInCaptcha(request(), {}, ctx({ email: 'nobody@example.com' })))).toBe('captcha_required');
    expect(await guardSignInCaptcha(request(), { captchaToken: await altchaToken('login') }, ctx())).toBeNull();
    expect(await refusal(await guardSignInCaptcha(request(), { captchaToken: await altchaToken('register') }, ctx()))).toBe('captcha_invalid');
  });

  it('honours a custom threshold', async () => {
    useSettings({ options: { loginFailureThreshold: 1 } });
    await failAccount(1);
    expect(await refusal(await guardSignInCaptcha(request(), {}, ctx()))).toBe('captcha_required');
  });

  it('asks when the client address is over the threshold — but only when clients can be told apart', async () => {
    for (let i = 0; i < 3; i += 1) await recordSignInFailure(request('198.51.100.20'));
    expect(await refusal(await guardSignInCaptcha(request('198.51.100.20'), {}, ctx({ email: 'fresh@example.com' })))).toBe('captcha_required');
    expect(await guardSignInCaptcha(request('198.51.100.21'), {}, ctx({ email: 'fresh@example.com' }))).toBeNull();

    vi.stubEnv('LOBBYFORGE_TRUSTED_PROXY', '');
    resetCaptchaMemoryForTests();
    for (let i = 0; i < 5; i += 1) await recordSignInFailure(request('198.51.100.30'));
    expect(await guardSignInCaptcha(request('198.51.100.30'), {}, ctx({ email: 'fresh@example.com' }))).toBeNull();
  });

  it('never asks a browser with a valid device cookie for the account — not even under "always" or in attack mode', async () => {
    await failAccount(5);
    expect(await guardSignInCaptcha(request(), {}, ctx({ hasDeviceClaim: true }))).toBeNull();
    useSettings({ surfaces: { register: 'on', invite_register: 'off', guest: 'on', login: 'always' }, attackMode: true });
    expect(await guardSignInCaptcha(request(), {}, ctx({ hasDeviceClaim: true }))).toBeNull();
  });

  it('"always" asks every time; "off" never', async () => {
    useSettings({ surfaces: { register: 'on', invite_register: 'off', guest: 'on', login: 'always' } });
    expect(await refusal(await guardSignInCaptcha(request(), {}, ctx()))).toBe('captcha_required');
    useSettings({ surfaces: { register: 'on', invite_register: 'off', guest: 'on', login: 'off' } });
    await failAccount(9);
    expect(await guardSignInCaptcha(request(), {}, ctx())).toBeNull();
  });

  it('attack mode by hand asks every sign-in without a device cookie', async () => {
    useSettings({ attackMode: true });
    expect(await refusal(await guardSignInCaptcha(request(), {}, ctx()))).toBe('captcha_required');
  });

  it('more than 50 failed sign-ins in 10 minutes turn attack mode on automatically', async () => {
    for (let i = 0; i < 50; i += 1) await recordSignInFailure(request(`203.0.113.${i}`));
    expect(await guardSignInCaptcha(request('192.0.2.1'), {}, ctx({ email: 'calm@example.com' }))).toBeNull();
    await recordSignInFailure(request('203.0.113.250'));
    expect(await refusal(await guardSignInCaptcha(request('192.0.2.1'), {}, ctx({ email: 'calm@example.com' })))).toBe('captcha_required');
    const config = await buildPublicCaptchaConfig('login');
    expect(config.required).toBe(true);
  });

  it('a challenge that cannot run (no session secret) does not block sign-in', async () => {
    useSettings({ attackMode: true });
    const token = await altchaToken('login');
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', '');
    expect(await guardSignInCaptcha(request(), { captchaToken: token }, ctx())).toBeNull();
  });

  it('a filled honeypot is refused', async () => {
    expect(await refusal(await guardSignInCaptcha(request(), { website: 'x' }, ctx()))).toBe('form_rejected');
  });
});

describe('public config (§4.1)', () => {
  it('register: required, ALTCHA, a form token — exactly the contract’s keys', async () => {
    const config = await buildPublicCaptchaConfig('register');
    expect(Object.keys(config).sort()).toEqual(['formToken', 'mode', 'options', 'provider', 'required', 'siteKey', 'surface']);
    expect(config).toMatchObject({
      surface: 'register',
      required: true,
      mode: 'on',
      provider: 'altcha',
      siteKey: null,
      options: { turnstileAppearance: 'interaction-only', recaptchaVersion: 'v3' },
    });
    expect(config.formToken).toMatch(/^\d{13}\.register\./);
  });

  it('invite_register is off by default (on an invite-only instance); login is adaptive (not required, no form token)', async () => {
    stored.registrationMode = 'invite_only';
    expect(await buildPublicCaptchaConfig('invite_register')).toMatchObject({ required: false, mode: 'off' });
    stored.registrationMode = 'open';
    const login = await buildPublicCaptchaConfig('login');
    expect(login).toMatchObject({ required: false, mode: 'adaptive', formToken: null });
    useSettings({ attackMode: true });
    expect(await buildPublicCaptchaConfig('login')).toMatchObject({ required: true, mode: 'adaptive' });
    useSettings({ surfaces: { register: 'on', invite_register: 'off', guest: 'on', login: 'always' } });
    expect(await buildPublicCaptchaConfig('login')).toMatchObject({ required: true, mode: 'always' });
  });

  it('provider none: nothing is required', async () => {
    useSettings({ provider: 'none' });
    expect(await buildPublicCaptchaConfig('guest')).toMatchObject({ required: false, mode: 'off', provider: 'none', siteKey: null });
  });

  it('a healthy external provider is served with its site key and probed lazily; an open breaker serves ALTCHA', async () => {
    turnstile({ options: { turnstileAppearance: 'always' } });
    transport.mockResolvedValue({ status: 200, body: { success: false, 'error-codes': ['invalid-input-response'] } });
    const config = await buildPublicCaptchaConfig('guest');
    expect(config).toMatchObject({ provider: 'turnstile', siteKey: '0x4AAAAAAAsite', options: { turnstileAppearance: 'always' } });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(new URLSearchParams(String(transport.mock.calls[0]![1])).get('response')).toBe('lobbyforge-reachability-probe');
    // Probed at most once per 60 s.
    await buildPublicCaptchaConfig('guest');
    expect(transport).toHaveBeenCalledTimes(1);

    transport.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 3; i += 1) await verifyCaptcha({ surface: 'guest', token: 'cf', provider: 'turnstile', req: request() });
    expect(await buildPublicCaptchaConfig('guest')).toMatchObject({ provider: 'altcha', siteKey: null });
  });

  it('a failing probe opens the breaker for the next readers', async () => {
    turnstile();
    transport.mockRejectedValue(new Error('down'));
    expect((await buildPublicCaptchaConfig('register')).provider).toBe('turnstile');
    await vi.waitFor(async () => expect((await getBreakerState('turnstile')).open).toBe(true));
    expect((await buildPublicCaptchaConfig('register')).provider).toBe('altcha');
  });

  it('a misconfigured external provider serves ALTCHA without probing', async () => {
    turnstile({ siteKey: null });
    expect(await buildPublicCaptchaConfig('register')).toMatchObject({ provider: 'altcha', siteKey: null });
    expect(transport).not.toHaveBeenCalled();
  });
});
