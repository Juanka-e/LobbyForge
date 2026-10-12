import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * GET /api/plugin-ui/{pluginId}: whether the lobby should frame a
 * marketplace plugin, which version, whether it projects its state, and
 * where its UI lives — its own files, or (phase 2) the author's approved site.
 */

const getDynamicPlugin = vi.fn();
vi.mock('@/lib/plugin-loader', () => ({ getDynamicPlugin }));
vi.mock('@lobbyforge/db', () => ({}));
vi.mock('@/lib/db', () => ({ getDb: vi.fn() }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
}));

const SECRET = 's'.repeat(48);
const DIGEST = 'b'.repeat(64);
let root: string;

function installBundle(
  pluginId: string,
  version: string,
  ui: boolean | { url: string },
  approved?: Record<string, unknown>
) {
  const dir = join(root, pluginId, version);
  mkdirSync(join(dir, 'ui'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ id: pluginId, name: pluginId, version, sdk: 'sandbox-v1', ui, actionPolicies: {} })
  );
  writeFileSync(join(dir, 'server.js'), 'globalThis.plugin = {};');
  writeFileSync(join(dir, 'ui', 'index.html'), '<p>ui</p>');
  writeFileSync(
    join(root, pluginId, 'active.json'),
    JSON.stringify({ version, digest: DIGEST, ...(approved ? { approved } : {}) })
  );
}

const GAME = 'https://game.example.com/play?room=1';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lf-plugin-frame-info-'));
  installBundle('sandbox-buzzer', '0.1.0', true);
  installBundle('headless', '1.0.0', false);
  // A folder named like an official plugin must never turn it into a frame.
  installBundle('hushle', '1.0.0', true);
  // The author's own site: approved / not approved / another URL approved.
  installBundle('external', '2.0.0', { url: GAME }, { uiUrl: GAME });
  installBundle('external-pending', '1.0.0', { url: GAME });
  installBundle('external-other', '1.0.0', { url: GAME }, { uiUrl: 'https://game.example.com/elsewhere' });
  // Sites on the instance's own address (LOBBYFORGE_APP_ORIGIN below), approved anyway.
  installBundle('own-host', '1.0.0', { url: 'https://chat.example.test/upload.html' }, { uiUrl: 'https://chat.example.test/upload.html' });
  installBundle('own-port', '1.0.0', { url: 'https://chat.example.test:8443/' }, { uiUrl: 'https://chat.example.test:8443/' });
  installBundle('own-subdomain', '1.0.0', { url: 'https://games.chat.example.test/' }, { uiUrl: 'https://games.chat.example.test/' });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const saved = { ...process.env };
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  process.env.LOBBYFORGE_PLUGIN_INSTALL_DIR = root;
  process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'true';
  process.env.LOBBYFORGE_APP_ORIGIN = 'https://chat.example.test';
  getDynamicPlugin.mockReset();
  getDynamicPlugin.mockImplementation((id: string) => ({ manifest: { id }, hasProjection: true }));
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...saved };
  errors.mockRestore();
});

function cookie(): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid: 'user-1', name: 'Guest' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

async function call(pluginId: string, withSession = true, base = 'http://localhost') {
  const { GET } = await import('../route');
  const req = new Request(`${base}/api/plugin-ui/${pluginId}`, {
    headers: withSession ? { cookie: cookie() } : {},
  });
  const res = await (GET as unknown as (r: Request, c: unknown) => Promise<Response>)(req, {
    params: Promise.resolve({ pluginId }),
  });
  return { status: res.status, body: (await res.json()) as { frame: unknown; error?: string } };
}

// The first test imports the route cold (plugin loader, layout helpers);
// under a full parallel run that alone can pass vitest's 5 s default.
describe('GET /api/plugin-ui/{pluginId}', { timeout: 20_000 }, () => {
  it('needs a signed-in user', async () => {
    const { status } = await call('sandbox-buzzer', false);
    expect(status).toBe(401);
  });

  it('names the active version, the projection flag and the files path for a loaded plugin with a UI', async () => {
    const { status, body } = await call('sandbox-buzzer');
    expect(status).toBe(200);
    expect(body.frame).toEqual({
      pluginId: 'sandbox-buzzer',
      version: '0.1.0',
      hasProjection: true,
      mode: 'files',
      src: '/api/plugin-ui/sandbox-buzzer/0.1.0/index.html',
    });
  });

  it('reports no projection unless the plugin explicitly says so', async () => {
    getDynamicPlugin.mockImplementation((id: string) => ({
      manifest: { id },
      // A forwarding method proves nothing about server.js.
      projectState: async (s: unknown) => s,
    }));
    expect((await call('sandbox-buzzer')).body.frame).toMatchObject({
      pluginId: 'sandbox-buzzer',
      version: '0.1.0',
      hasProjection: false,
    });
    getDynamicPlugin.mockImplementation((id: string) => ({ manifest: { id, hasProjection: true } }));
    expect((await call('sandbox-buzzer')).body.frame).toMatchObject({ hasProjection: true });
  });

  it('has nothing to frame for official plugins, UI-less or unloaded ones, or with dynamic plugins off', async () => {
    expect(await call('hushle')).toEqual({ status: 404, body: { frame: null } });
    expect(await call('headless')).toEqual({ status: 404, body: { frame: null } });
    expect(await call('not-installed')).toEqual({ status: 404, body: { frame: null } });
    getDynamicPlugin.mockReturnValue(null);
    expect(await call('sandbox-buzzer')).toEqual({ status: 404, body: { frame: null } });
    expect(await call('external')).toEqual({ status: 404, body: { frame: null } });
    getDynamicPlugin.mockImplementation((id: string) => ({ manifest: { id }, hasProjection: true }));
    process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'false';
    expect(await call('sandbox-buzzer')).toEqual({ status: 404, body: { frame: null } });
  });
});

describe('GET /api/plugin-ui/{pluginId} — the author’s own site (phase 2)', { timeout: 20_000 }, () => {
  it('names the approved URL and its origin instead of a files path', async () => {
    const { status, body } = await call('external');
    expect(status).toBe(200);
    expect(body.frame).toEqual({
      pluginId: 'external',
      version: '2.0.0',
      hasProjection: true,
      mode: 'external',
      src: GAME,
      origin: 'https://game.example.com',
    });
  });

  it('names nothing until the owner approved exactly that URL', async () => {
    expect(await call('external-pending')).toEqual({ status: 404, body: { frame: null } });
    expect(await call('external-other')).toEqual({ status: 404, body: { frame: null } });
  });

  it('never names a site on the instance’s own address: the host on any port, or a subdomain', async () => {
    for (const id of ['own-host', 'own-port', 'own-subdomain']) {
      expect(await call(id), id).toEqual({ status: 404, body: { frame: null } });
    }
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('own address'), expect.any(String));
  });

  it('counts the origin the request came in on as the instance’s own, too', async () => {
    delete process.env.LOBBYFORGE_APP_ORIGIN;
    // Without a configured origin, the site is fine…
    expect((await call('external')).status).toBe(200);
    // …unless the app is being reached on that very host.
    expect(await call('external', true, 'https://game.example.com')).toEqual({ status: 404, body: { frame: null } });
  });
});
