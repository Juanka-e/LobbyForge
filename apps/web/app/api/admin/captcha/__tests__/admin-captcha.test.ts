/**
 * Admin bot protection API (docs/CAPTCHA.md §6.1): GET / PUT
 * /api/admin/captcha and POST /api/admin/captcha/test — owner-only, the
 * secret write-only (encrypted at rest, never returned, never audited),
 * environment locks, keys_required, and the audit entry with field names.
 */
import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  stored: { current: {} as Record<string, unknown> },
  setInstanceCaptchaSettings: vi.fn(),
  logAction: vi.fn(),
  requireInstanceAdmin: vi.fn(),
  probeSiteverify: vi.fn(),
}));

vi.mock('@lobbyforge/db', () => ({
  getInstanceCaptchaSettings: async () => ({ ...h.stored.current }),
  setInstanceCaptchaSettings: h.setInstanceCaptchaSettings,
  getInstanceBootstrapStatus: async () => ({ instanceId: 'self-host', firstServerId: '11111111-1111-4111-8111-111111111111' }),
  logAction: h.logAction,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/admin-auth', () => ({ requireInstanceAdmin: h.requireInstanceAdmin }));
vi.mock('@/lib/security-headers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security-headers')>('@/lib/security-headers');
  return { ...actual, withApiSecurity: (handler: unknown) => handler };
});
vi.mock('@/lib/captcha/providers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/captcha/providers')>('@/lib/captcha/providers');
  return { ...actual, probeSiteverify: h.probeSiteverify };
});

import { buildGuestSessionCookie } from '@/lib/guest-session';
import { decryptCaptchaSecret, encryptCaptchaSecret } from '@/lib/captcha/secret';
import { invalidateCaptchaSettingsCache } from '@/lib/captcha/settings';
import { openBreaker, getBreakerState } from '@/lib/captcha/breaker';
import { resetCaptchaMemoryForTests } from '@/lib/captcha/store';

const SECRET = 'a'.repeat(48);
const OWNER = '22222222-2222-4222-8222-222222222222';

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

const validBody = {
  provider: 'altcha',
  surfaces: { register: 'on', invite_register: 'off', guest: 'on', login: 'adaptive' },
  options: {},
  attackMode: false,
};

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  for (const name of ['LOBBYFORGE_CAPTCHA_PROVIDER', 'LOBBYFORGE_CAPTCHA_SITE_KEY', 'LOBBYFORGE_CAPTCHA_SECRET_KEY']) vi.stubEnv(name, '');
  h.stored.current = row();
  h.setInstanceCaptchaSettings.mockReset().mockImplementation(async (_db: unknown, input: Record<string, unknown>) => {
    const next = { ...h.stored.current };
    if (input.provider !== undefined) next.provider = input.provider;
    if (input.surfaces !== undefined) next.surfaces = input.surfaces;
    if (input.siteKey !== undefined) next.siteKey = input.siteKey;
    if (input.secretEncrypted !== undefined) next.secretEncrypted = input.secretEncrypted;
    if (input.options !== undefined) next.options = input.options;
    if (input.attackMode !== undefined) next.attackMode = input.attackMode;
    h.stored.current = next;
    return next;
  });
  h.logAction.mockReset().mockResolvedValue(undefined);
  h.requireInstanceAdmin.mockReset().mockResolvedValue(null);
  h.probeSiteverify.mockReset();
  resetCaptchaMemoryForTests();
  invalidateCaptchaSettingsCache();
});

function ownerCookie(): string {
  return `lf_guest=${buildGuestSessionCookie({ gid: 'g_'.padEnd(34, 'a'), uid: OWNER, name: 'Owner' }, SECRET).raw}`;
}

async function get() {
  const { GET } = await import('../route.js');
  return GET(new Request('https://community.example/api/admin/captcha'), {});
}

async function put(body: unknown) {
  const { PUT } = await import('../route.js');
  return PUT(
    new Request('https://community.example/api/admin/captcha', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: ownerCookie() },
      body: JSON.stringify(body),
    }),
    {}
  );
}

async function test(body: unknown) {
  const { POST } = await import('../test/route.js');
  return POST(
    new Request('https://community.example/api/admin/captcha/test', { method: 'POST', body: JSON.stringify(body) }),
    {}
  );
}

describe('GET /api/admin/captcha', { timeout: 20_000 }, () => {
  it('owner only', async () => {
    h.requireInstanceAdmin.mockResolvedValue(NextResponse.json({ error: 'Instance owner authentication required' }, { status: 401 }));
    expect((await get()).status).toBe(401);
    expect((await put(validBody)).status).toBe(401);
    expect((await test({})).status).toBe(401);
    expect(h.setInstanceCaptchaSettings).not.toHaveBeenCalled();
  });

  it('returns the contract shape with every option default filled in', async () => {
    const response = await get();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      provider: 'altcha',
      // password_reset (docs/EMAIL.md §4.3) defaults to on, also for rows saved before it existed.
      surfaces: { register: 'on', invite_register: 'off', guest: 'on', login: 'adaptive', password_reset: 'on' },
      siteKey: null,
      secretSet: false,
      secretHint: null,
      options: {
        altchaDifficulty: 'normal',
        turnstileAppearance: 'interaction-only',
        recaptchaVersion: 'v3',
        recaptchaMinScore: 0.5,
        loginFailureThreshold: 3,
      },
      attackMode: { manual: false, autoUntil: null },
      locked: { provider: false, siteKey: false, secretKey: false },
      breaker: { open: false, until: null },
    });
  });

  it('shows a secret as set with a hint, never the secret; reports the breaker and env locks', async () => {
    h.stored.current = row({ provider: 'turnstile', siteKey: '0x4AAAAsite', secretEncrypted: encryptCaptchaSecret('0x4AAAAAAAsecretVALUEwxyz') });
    vi.stubEnv('LOBBYFORGE_CAPTCHA_SITE_KEY', '0x4AAAAenv');
    await openBreaker('turnstile', 'probe');
    const text = await (await get()).text();
    expect(text).not.toContain('secretVALUE');
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      provider: 'turnstile',
      siteKey: '0x4AAAAenv',
      secretSet: true,
      secretHint: '…wxyz',
      locked: { provider: false, siteKey: true, secretKey: false },
      breaker: { open: true },
    });
    expect(new Date(body.breaker.until).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('PUT /api/admin/captcha', { timeout: 20_000 }, () => {
  it('saves the password_reset surface; a client that predates it keeps the stored value', async () => {
    const off = await put({ ...validBody, surfaces: { ...validBody.surfaces, password_reset: 'off' } });
    expect(off.status).toBe(200);
    expect((await off.json()).surfaces.password_reset).toBe('off');
    expect((h.stored.current.surfaces as Record<string, string>).password_reset).toBe('off');
    // The old four-key body: password_reset stays off.
    const legacy = await put(validBody);
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).surfaces.password_reset).toBe('off');
    expect((await put({ ...validBody, surfaces: { ...validBody.surfaces, password_reset: 'maybe' } })).status).toBe(400);
  });

  it('saves, answers the GET shape, and audits the changed field NAMES only', async () => {
    const response = await put({
      ...validBody,
      provider: 'turnstile',
      siteKey: '0x4AAAAAAAsite',
      secretKey: '0x4AAAAAAAnewSECRETvalue',
      surfaces: { register: 'on', invite_register: 'on', guest: 'off', login: 'always' },
      options: { turnstileAppearance: 'always', loginFailureThreshold: 5 },
      attackMode: true,
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('newSECRETvalue');
    expect(JSON.parse(text)).toMatchObject({
      provider: 'turnstile',
      siteKey: '0x4AAAAAAAsite',
      secretSet: true,
      secretHint: '…alue',
      surfaces: { invite_register: 'on', guest: 'off', login: 'always' },
      options: { turnstileAppearance: 'always', loginFailureThreshold: 5, altchaDifficulty: 'normal' },
      attackMode: { manual: true, autoUntil: null },
    });
    // Encrypted at rest.
    const written = h.setInstanceCaptchaSettings.mock.calls[0]![1] as Record<string, string>;
    expect(written.secretEncrypted).toMatch(/^v1\./);
    expect(decryptCaptchaSecret(written.secretEncrypted)).toBe('0x4AAAAAAAnewSECRETvalue');
    // Audited: who, which fields — no values.
    expect(h.logAction).toHaveBeenCalledTimes(1);
    const entry = h.logAction.mock.calls[0]![1];
    expect(entry).toMatchObject({
      action: 'instance.captcha_updated',
      actorUserId: OWNER,
      serverId: '11111111-1111-4111-8111-111111111111',
      targetType: 'instance',
      metadata: { fields: ['provider', 'surfaces', 'siteKey', 'secretKey', 'options', 'attackMode'] },
    });
    expect(JSON.stringify(entry)).not.toContain('SECRET');
    expect(JSON.stringify(entry)).not.toContain('0x4AAAAAAAsite');
  });

  it('keeps the secret when it is omitted (or blank), clears it with null', async () => {
    h.stored.current = row({ provider: 'turnstile', siteKey: 'site', secretEncrypted: encryptCaptchaSecret('kept-secret-1234') });
    await put({ ...validBody, provider: 'turnstile', secretKey: '' });
    expect(h.setInstanceCaptchaSettings.mock.calls[0]![1]).not.toHaveProperty('secretEncrypted');
    expect(decryptCaptchaSecret(h.stored.current.secretEncrypted as string)).toBe('kept-secret-1234');
    expect(h.logAction).not.toHaveBeenCalled(); // nothing changed

    const cleared = await put({ ...validBody, provider: 'altcha', secretKey: null, siteKey: null });
    expect(cleared.status).toBe(200);
    expect(h.stored.current).toMatchObject({ secretEncrypted: null, siteKey: null, provider: 'altcha' });
    expect(h.logAction.mock.calls[0]![1].metadata).toEqual({ fields: ['provider', 'siteKey', 'secretKey'] });
  });

  it('making a default explicit is not a change', async () => {
    await put({ ...validBody, options: { altchaDifficulty: 'normal', recaptchaMinScore: 0.5 } });
    expect(h.logAction).not.toHaveBeenCalled();
  });

  it('400 keys_required for an external provider without both keys', async () => {
    for (const body of [
      { ...validBody, provider: 'turnstile' },
      { ...validBody, provider: 'recaptcha', siteKey: 'site' },
      { ...validBody, provider: 'turnstile', secretKey: 'secret-only-1234' },
    ]) {
      const response = await put(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'keys_required' });
    }
    expect(h.setInstanceCaptchaSettings).not.toHaveBeenCalled();
  });

  it('400 invalid_settings with the issues (paths, never values)', async () => {
    const cases = [
      { ...validBody, provider: 'hcaptcha' },
      { ...validBody, surfaces: { ...validBody.surfaces, login: 'on' } },
      { ...validBody, options: { recaptchaMinScore: 0.95 } },
      { ...validBody, options: { loginFailureThreshold: 11 } },
      { ...validBody, options: { unknown: true } },
      { ...validBody, extra: 1 },
      { ...validBody, attackMode: 'yes' },
      { ...validBody, secretKey: 'x'.repeat(513) },
    ];
    for (const body of cases) {
      const response = await put(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      const json = await response.json();
      expect(json.error).toBe('invalid_settings');
      expect(Array.isArray(json.issues)).toBe(true);
      expect(JSON.stringify(json)).not.toContain('x'.repeat(50));
    }
  });

  it('409 locked_by_env when a locked field would change; the same value passes', async () => {
    vi.stubEnv('LOBBYFORGE_CAPTCHA_PROVIDER', 'none');
    let response = await put({ ...validBody, provider: 'altcha' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'locked_by_env', field: 'provider' });
    response = await put({ ...validBody, provider: 'none' });
    expect(response.status).toBe(200);
    // The env value is not copied into the database.
    expect(h.setInstanceCaptchaSettings.mock.calls[0]![1]).not.toHaveProperty('provider');

    vi.stubEnv('LOBBYFORGE_CAPTCHA_PROVIDER', '');
    vi.stubEnv('LOBBYFORGE_CAPTCHA_SECRET_KEY', 'env-secret');
    invalidateCaptchaSettingsCache();
    response = await put({ ...validBody, secretKey: 'other' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'locked_by_env', field: 'secretKey' });

    vi.stubEnv('LOBBYFORGE_CAPTCHA_SITE_KEY', 'env-site');
    invalidateCaptchaSettingsCache();
    response = await put({ ...validBody, siteKey: 'other-site' });
    expect(await response.json()).toEqual({ error: 'locked_by_env', field: 'siteKey' });
    // Env keys count for keys_required.
    response = await put({ ...validBody, provider: 'turnstile', siteKey: 'env-site' });
    expect(response.status).toBe(200);
  });

  it('503 settings_unavailable when the stored row cannot be read — never a save against the defaults', async () => {
    const db = await import('@lobbyforge/db');
    vi.spyOn(db, 'getInstanceCaptchaSettings').mockRejectedValueOnce(new Error('connection refused'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await put(validBody);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'settings_unavailable' });
    expect(h.setInstanceCaptchaSettings).not.toHaveBeenCalled();
    expect(h.logAction).not.toHaveBeenCalled();
  });

  it('new keys reset the breaker', async () => {
    h.stored.current = row({ provider: 'turnstile', siteKey: 'site', secretEncrypted: encryptCaptchaSecret('old-secret-12345') });
    await openBreaker('turnstile', 'bad_secret');
    await put({ ...validBody, provider: 'turnstile', secretKey: 'new-secret-12345' });
    expect((await getBreakerState('turnstile')).open).toBe(false);
  });
});

describe('POST /api/admin/captcha/test', { timeout: 20_000 }, () => {
  it('not_applicable for none and ALTCHA', async () => {
    expect(await (await test({})).json()).toEqual({ result: 'not_applicable' });
    expect(await (await test({ provider: 'none' })).json()).toEqual({ result: 'not_applicable' });
    expect(h.probeSiteverify).not.toHaveBeenCalled();
  });

  it('missing_keys, falling back to the saved values for what is left out', async () => {
    expect(await (await test({ provider: 'turnstile' })).json()).toEqual({ result: 'missing_keys', detail: 'missing_both' });
    expect(await (await test({ provider: 'turnstile', siteKey: 's' })).json()).toEqual({ result: 'missing_keys', detail: 'missing_secret_key' });
    expect(await (await test({ provider: 'recaptcha', secretKey: 'x' })).json()).toEqual({ result: 'missing_keys', detail: 'missing_site_key' });
    h.stored.current = row({ provider: 'turnstile', siteKey: 'saved-site', secretEncrypted: encryptCaptchaSecret('saved-secret-1234') });
    invalidateCaptchaSettingsCache();
    h.probeSiteverify.mockResolvedValue('ok');
    expect(await (await test({})).json()).toEqual({ result: 'ok' });
    expect(h.probeSiteverify).toHaveBeenCalledWith('turnstile', 'saved-secret-1234');
    await test({ secretKey: 'typed-secret' });
    expect(h.probeSiteverify).toHaveBeenLastCalledWith('turnstile', 'typed-secret');
  });

  it('reports bad_secret and unreachable; flags test keys', async () => {
    h.probeSiteverify.mockResolvedValueOnce('bad_secret').mockResolvedValueOnce('unreachable').mockResolvedValueOnce('ok');
    expect(await (await test({ provider: 'turnstile', siteKey: 's', secretKey: 'x' })).json()).toEqual({ result: 'bad_secret' });
    expect(await (await test({ provider: 'recaptcha', siteKey: 's', secretKey: 'x' })).json()).toEqual({ result: 'unreachable' });
    const testKeys = await (await test({ provider: 'turnstile', siteKey: '1x00000000000000000000AA', secretKey: '1x0000000000000000000000000000000AA' })).json();
    expect(testKeys.result).toBe('ok');
    expect(testKeys.detail).toBe('test_keys');
  });

  it('refuses unknown fields', async () => {
    expect((await test({ provider: 'turnstile', token: 'x' })).status).toBe(400);
  });

  it('detail is always one of the six codes the admin card translates — never a sentence', async () => {
    const codes = new Set(['secret_undecryptable', 'missing_site_key', 'missing_secret_key', 'missing_both', 'test_keys', 'recaptcha_reachability_only']);
    h.probeSiteverify.mockResolvedValue('ok');
    const recaptcha = await (await test({ provider: 'recaptcha', siteKey: 's', secretKey: 'real-secret' })).json();
    expect(recaptcha).toEqual({ result: 'ok', detail: 'recaptcha_reachability_only' });
    const googleTest = await (await test({ provider: 'recaptcha', siteKey: 's', secretKey: '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe' })).json();
    expect(googleTest).toEqual({ result: 'ok', detail: 'test_keys' });
    expect(await (await test({ provider: 'turnstile', siteKey: 's', secretKey: 'real-secret' })).json()).toEqual({ result: 'ok' });
    // A saved secret the current session secret cannot decrypt.
    h.stored.current = row({ provider: 'turnstile', siteKey: 'saved-site', secretEncrypted: 'v1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA' });
    invalidateCaptchaSettingsCache();
    const undecryptable = await (await test({})).json();
    expect(undecryptable).toEqual({ result: 'missing_keys', detail: 'secret_undecryptable' });
    for (const body of [recaptcha, googleTest, undecryptable]) expect(codes.has(body.detail)).toBe(true);
  });
});
