/**
 * GET /api/auth/captcha (public config, docs/CAPTCHA.md §4.1) and
 * GET /api/auth/captcha/challenge (ALTCHA challenge, §4.2).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { stored } = vi.hoisted(() => ({ stored: { current: {} as Record<string, unknown> } }));
vi.mock('@lobbyforge/db', () => ({
  getInstanceCaptchaSettings: async () => ({ ...stored.current }),
  findOrCreateGuestUser: async ({ displayName }: { displayName: string }) => ({ id: '00000000-0000-4000-8000-0000000000aa', displayName }),
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/instance-access', () => ({ authorizeGuestRegistration: async () => ({ ok: true }) }));
vi.mock('@/lib/session-tracker', () => ({ isSessionRevoked: async () => false, recordSession: async () => undefined }));
vi.mock('@/lib/security-headers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security-headers')>('@/lib/security-headers');
  return { ...actual, withApiSecurity: (handler: unknown) => handler };
});

function row(overrides: Record<string, unknown> = {}) {
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

beforeEach(async () => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'r'.repeat(40));
  vi.stubEnv('LOBBYFORGE_CAPTCHA_PROVIDER', '');
  stored.current = row();
  const { invalidateCaptchaSettingsCache } = await import('@/lib/captcha/settings');
  invalidateCaptchaSettingsCache();
});

async function getConfig(query: string) {
  const { GET } = await import('../route.js');
  return GET(new Request(`https://community.example/api/auth/captcha${query}`), {});
}

async function getChallenge(query: string) {
  const { GET } = await import('../challenge/route.js');
  return GET(new Request(`https://community.example/api/auth/captcha/challenge${query}`), {});
}

describe('GET /api/auth/captcha', { timeout: 20_000 }, () => {
  it('answers the surface’s config, uncached', async () => {
    const response = await getConfig('?surface=guest');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ surface: 'guest', required: true, mode: 'on', provider: 'altcha', siteKey: null });
    expect(typeof body.formToken).toBe('string');
  });

  it('never carries a secret', async () => {
    const { encryptCaptchaSecret } = await import('@/lib/captcha/secret');
    stored.current = row({ provider: 'turnstile', siteKey: '0x4AAAAAAAsite', secretEncrypted: encryptCaptchaSecret('0x4AAAAAAATOPSECRET') });
    const { setSiteverifyTransportForTests } = await import('@/lib/captcha/providers');
    setSiteverifyTransportForTests(async () => ({ status: 200, body: { success: false, 'error-codes': ['invalid-input-response'] } }));
    const text = await (await getConfig('?surface=register')).text();
    expect(text).toContain('0x4AAAAAAAsite');
    expect(text).not.toContain('TOPSECRET');
    expect(text).not.toContain('v1.');
    setSiteverifyTransportForTests(null);
  });

  it('refuses an unknown surface', async () => {
    for (const query of ['', '?surface=admin', '?surface=REGISTER']) {
      const response = await getConfig(query);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_surface' });
    }
  });
});

describe('GET /api/auth/captcha/challenge', { timeout: 20_000 }, () => {
  it('serves a signed altcha-lib v2 challenge bound to the surface', async () => {
    const response = await getChallenge('?surface=register');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['parameters', 'signature']);
    expect(body.parameters).toMatchObject({ algorithm: 'PBKDF2/SHA-256', data: { surface: 'register' } });
    expect(body.parameters.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it('uses the configured difficulty', async () => {
    stored.current = row({ options: { altchaDifficulty: 'hard' } });
    const { ALTCHA_DIFFICULTY } = await import('@/lib/captcha/altcha');
    const body = await (await getChallenge('?surface=guest')).json();
    expect(body.parameters.cost).toBe(ALTCHA_DIFFICULTY.hard.cost);
  });

  it('refuses an unknown surface; answers 503 without a session secret', async () => {
    expect((await getChallenge('?surface=nope')).status).toBe(400);
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await getChallenge('?surface=login');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'captcha_unavailable' });
  });
});

// The whole wire, as the widget and the e2e helpers do it: config → challenge
// → solve with altcha-lib → POST /api/auth/guest with the token and the form
// token — through the real guard, ALTCHA verification and replay marker.
describe('end to end through POST /api/auth/guest', { timeout: 20_000 }, () => {
  it('a solved challenge creates the guest once; the replay and a rushed form are refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { solveChallenge } = await import('altcha-lib');
    const { deriveKey } = await import('altcha-lib/algorithms/pbkdf2');
    const { POST } = await import('../../guest/route.js');
    const guest = (body: Record<string, unknown>) =>
      POST(new Request('https://community.example/api/auth/guest', { method: 'POST', body: JSON.stringify(body) }), {});

    expect(await (await guest({})).json()).toEqual({ error: 'captcha_required' });

    const config = await (await getConfig('?surface=guest')).json();
    const challenge = await (await getChallenge('?surface=guest')).json();
    const solution = await solveChallenge({ challenge, deriveKey });
    const captchaToken = Buffer.from(JSON.stringify({ challenge, solution })).toString('base64');
    const body = { captchaToken, captchaProvider: 'altcha', formToken: config.formToken, website: '' };

    expect(await (await guest(body)).json()).toEqual({ error: 'form_rejected' }); // < 2 s after the config
    vi.setSystemTime(Date.now() + 2_500);
    const created = await guest(body);
    expect(created.status).toBe(200);
    expect(created.headers.get('set-cookie')).toContain('lf_guest=');
    const replay = await guest(body);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'captcha_invalid' });
    vi.useRealTimers();
  });
});
