/**
 * Admin → Overview → Default language: GET / PUT /api/admin/default-locale.
 * Instance owner only (the real `requireInstanceAdmin`, against a mocked
 * settings row); every installed language listed with its status; the
 * saved value validated against the languages on disk, stored, used at
 * once, and audited like the other instance settings.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  saved: { current: null as string | null },
  setInstanceDefaultLocale: vi.fn(),
  logAction: vi.fn(),
}));

vi.mock('@lobbyforge/db', () => ({
  getInstanceSetupStatus: async () => ({ instanceId: 'self-host', ownerUserId: '22222222-2222-4222-8222-222222222222', bootstrapVersion: 2 }),
  getInstanceBootstrapStatus: async () => ({ instanceId: 'self-host', firstServerId: '11111111-1111-4111-8111-111111111111' }),
  getInstanceDefaultLocaleSetting: async () => h.saved.current,
  setInstanceDefaultLocale: h.setInstanceDefaultLocale,
  logAction: h.logAction,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/active-session', () => ({ isSessionActive: async () => true }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

import { buildGuestSessionCookie } from '@/lib/guest-session';
import { __resetInstanceDefaultLocaleForTests, getInstanceDefaultLocale } from '@/lib/i18n/instance-default';

const SECRET = 'a'.repeat(48);
const OWNER = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const ADMIN_TOKEN = 't'.repeat(40);

const cookieFor = (uid: string) => `lf_guest=${buildGuestSessionCookie({ gid: `g_${'b'.repeat(32)}`, uid, name: 'Someone' }, SECRET).raw}`;

async function call(method: 'GET' | 'PUT', opts: { cookie?: string; token?: string; body?: unknown } = {}) {
  const route = await import('../route.js');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.token) headers['x-lobbyforge-admin-token'] = opts.token;
  const req = new Request('https://community.example/api/admin/default-locale', {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) }),
  });
  return method === 'GET' ? route.GET(req, {}) : route.PUT(req, {});
}

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  vi.stubEnv('LOBBYFORGE_ADMIN_TOKEN', ADMIN_TOKEN);
  vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', '');
  __resetInstanceDefaultLocaleForTests();
  h.saved.current = null;
  h.setInstanceDefaultLocale.mockReset().mockImplementation(async (_db: unknown, locale: string | null) => {
    const previous = h.saved.current;
    h.saved.current = locale;
    return { previous, current: locale };
  });
  h.logAction.mockReset().mockResolvedValue(undefined);
});

describe('the guard', () => {
  it('refuses the signed out, members who are not the owner, and a wrong token — before anything is read or written', async () => {
    for (const opts of [{}, { cookie: cookieFor(MEMBER) }, { token: 'x'.repeat(40) }]) {
      expect((await call('GET', opts)).status).toBe(401);
      expect((await call('PUT', { ...opts, body: { locale: 'tr' } })).status).toBe(401);
    }
    expect(h.setInstanceDefaultLocale).not.toHaveBeenCalled();
    expect(h.logAction).not.toHaveBeenCalled();
  });

  it('lets the owner and the operator token in', async () => {
    expect((await call('GET', { cookie: cookieFor(OWNER) })).status).toBe(200);
    expect((await call('GET', { token: ADMIN_TOKEN })).status).toBe(200);
  });
});

describe('GET', () => {
  it('lists every installed language in its own name with its status, and says English decides when nothing is set', async () => {
    const body = await (await call('GET', { cookie: cookieFor(OWNER) })).json();
    expect(body.locales).toEqual(
      expect.arrayContaining([
        { code: 'en', name: 'English', englishName: 'English', status: 'complete' },
        { code: 'tr', name: 'Türkçe', englishName: 'Turkish', status: 'complete' },
      ])
    );
    expect(body).toMatchObject({ code: 'en', source: 'fallback', saved: null, env: null });
  });

  it('says when the env decides, and when a saved value overrides it', async () => {
    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', 'tr');
    expect(await (await call('GET', { cookie: cookieFor(OWNER) })).json()).toMatchObject({ code: 'tr', source: 'env', env: 'tr', envInstalled: true });
    h.saved.current = 'en';
    expect(await (await call('GET', { cookie: cookieFor(OWNER) })).json()).toMatchObject({ code: 'en', source: 'saved', saved: 'en', env: 'tr' });
  });
});

describe('PUT', () => {
  it('saves an installed language, uses it at once, and audits the change', async () => {
    const res = await call('PUT', { cookie: cookieFor(OWNER), body: { locale: 'TR' } });
    expect(res.status).toBe(200);
    expect(h.setInstanceDefaultLocale).toHaveBeenCalledWith(expect.anything(), 'tr');
    expect(await res.json()).toMatchObject({ code: 'tr', source: 'saved', saved: 'tr' });
    expect(await getInstanceDefaultLocale()).toBe('tr');
    expect(h.logAction).toHaveBeenCalledWith(expect.anything(), {
      serverId: '11111111-1111-4111-8111-111111111111',
      actorUserId: OWNER,
      action: 'instance.default_locale_updated',
      targetType: 'instance',
      targetId: 'self-host',
      metadata: { from: null, to: 'tr' },
    });
  });

  it('clears it with null, handing back to the env and then English', async () => {
    h.saved.current = 'tr';
    vi.stubEnv('LOBBYFORGE_DEFAULT_LOCALE', 'en');
    const res = await call('PUT', { token: ADMIN_TOKEN, body: { locale: null } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ code: 'en', source: 'env', saved: null });
    // The operator token has no account behind it.
    expect(h.logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorUserId: null, metadata: { from: 'tr', to: null } }));
  });

  it('does not audit a save that changes nothing', async () => {
    h.saved.current = 'tr';
    expect((await call('PUT', { cookie: cookieFor(OWNER), body: { locale: 'tr' } })).status).toBe(200);
    expect(h.logAction).not.toHaveBeenCalled();
  });

  it('refuses a language that is not installed, and a malformed body, without writing', async () => {
    for (const body of [{ locale: 'de' }, { locale: '../../etc' }, { locale: 'tr', extra: 1 }, { locale: 7 }, {}, 'not json']) {
      expect((await call('PUT', { cookie: cookieFor(OWNER), body })).status).toBe(400);
    }
    expect(h.setInstanceDefaultLocale).not.toHaveBeenCalled();
  });
});
