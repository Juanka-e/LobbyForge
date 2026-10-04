import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * GET /api/plugin-ui/{pluginId}: whether the lobby should frame a
 * marketplace plugin, which version, and whether it projects its state.
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

function installBundle(pluginId: string, version: string, ui: boolean) {
  const dir = join(root, pluginId, version);
  mkdirSync(join(dir, 'ui'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ id: pluginId, name: pluginId, version, sdk: 'sandbox-v1', ui, actionPolicies: {} })
  );
  writeFileSync(join(dir, 'server.js'), 'globalThis.plugin = {};');
  writeFileSync(join(dir, 'ui', 'index.html'), '<p>ui</p>');
  writeFileSync(join(root, pluginId, 'active.json'), JSON.stringify({ version, digest: DIGEST }));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lf-plugin-frame-info-'));
  installBundle('sandbox-buzzer', '0.1.0', true);
  installBundle('headless', '1.0.0', false);
  // A folder named like an official plugin must never turn it into a frame.
  installBundle('hushle', '1.0.0', true);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const saved = { ...process.env };
beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  process.env.LOBBYFORGE_PLUGIN_INSTALL_DIR = root;
  process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'true';
  getDynamicPlugin.mockReset();
  getDynamicPlugin.mockImplementation((id: string) => ({ manifest: { id }, hasProjection: true }));
});
afterEach(() => {
  process.env = { ...saved };
});

function cookie(): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid: 'user-1', name: 'Guest' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

async function call(pluginId: string, withSession = true) {
  const { GET } = await import('../route');
  const req = new Request(`http://localhost/api/plugin-ui/${pluginId}`, {
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

  it('names the active version and the projection flag for a loaded plugin with a UI', async () => {
    const { status, body } = await call('sandbox-buzzer');
    expect(status).toBe(200);
    expect(body.frame).toEqual({ pluginId: 'sandbox-buzzer', version: '0.1.0', hasProjection: true });
  });

  it('reports no projection unless the plugin explicitly says so', async () => {
    getDynamicPlugin.mockImplementation((id: string) => ({
      manifest: { id },
      // A forwarding method proves nothing about server.js.
      projectState: async (s: unknown) => s,
    }));
    expect((await call('sandbox-buzzer')).body.frame).toEqual({
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
    getDynamicPlugin.mockImplementation((id: string) => ({ manifest: { id }, hasProjection: true }));
    process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'false';
    expect(await call('sandbox-buzzer')).toEqual({ status: 404, body: { frame: null } });
  });
});
