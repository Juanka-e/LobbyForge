import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireAdminHealthToken = vi.fn();
const getCatalogEntry = vi.fn();
const incrementDownloadCount = vi.fn();
const installPluginBundle = vi.fn();
const logAction = vi.fn();
const getInstanceBootstrapStatus = vi.fn();

vi.mock('@/lib/admin-auth', () => ({ requireAdminHealthToken }));
vi.mock('@lobbyforge/db', () => ({ getCatalogEntry, incrementDownloadCount, logAction, getInstanceBootstrapStatus }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/plugin-installer', () => ({ installPluginBundle }));

beforeEach(() => {
  vi.resetModules();
  // Enable dynamic plugins for install tests.
  vi.stubEnv('LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED', 'true');
  requireAdminHealthToken.mockReset();
  getCatalogEntry.mockReset();
  incrementDownloadCount.mockReset();
  installPluginBundle.mockReset();
  requireAdminHealthToken.mockResolvedValue(null);
  incrementDownloadCount.mockResolvedValue(undefined);
  logAction.mockReset().mockResolvedValue(undefined);
  getInstanceBootstrapStatus.mockReset().mockResolvedValue({ firstServerId: 'srv-1', instanceId: 'self-host' });
});

describe('POST /api/marketplace/install', () => {
  it('installs an approved plugin with a manifestUrl', async () => {
    getCatalogEntry.mockResolvedValue({
      pluginId: 'cool-game', name: 'Cool Game', version: '1.0.0',
      reviewStatus: 'approved', manifestUrl: 'https://cdn.example.dev/cool-game-1.0.0.tgz',
      bundleSha256: 'b'.repeat(64), bundleSizeBytes: 2048, id: 'x',
    });
    installPluginBundle.mockResolvedValue({ ok: true, path: '/plugins/installed/cool-game/1.0.0' });
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({ pluginId: 'cool-game' }),
      }),
      {}
    );
    expect(res.status).toBe(200);
    expect(installPluginBundle).toHaveBeenCalledWith(
      'cool-game', 'https://cdn.example.dev/cool-game-1.0.0.tgz', '1.0.0',
      { sha256: 'b'.repeat(64), sizeBytes: 2048 },
      null
    );
    // Filed in the audit log under the instance's community.
    expect(logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      serverId: 'srv-1', action: 'plugin.install', targetType: 'plugin', targetId: 'cool-game',
      metadata: { version: '1.0.0', approved: null },
    }));
  });

  it('14th-audit: FAILS CLOSED on an approved row with no pin (re-review required)', async () => {
    getCatalogEntry.mockResolvedValue({
      pluginId: 'legacy-game', reviewStatus: 'approved',
      manifestUrl: 'https://cdn.example.dev/legacy.tgz',
      bundleSha256: null, bundleSizeBytes: null, id: 'legacy',
    });
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({ pluginId: 'legacy-game' }),
      }),
      {}
    );
    expect(res.status).toBe(409);
    expect(installPluginBundle).not.toHaveBeenCalled();
  });

  it('13th-audit: passes the REVIEWED pin to the installer', async () => {
    getCatalogEntry.mockResolvedValue({
      pluginId: 'pinned-game', reviewStatus: 'approved', version: '2.0.0',
      manifestUrl: 'https://cdn.example.dev/pinned-2.0.0.tgz',
      bundleSha256: 'a'.repeat(64), bundleSizeBytes: 4096, id: 'z',
    });
    installPluginBundle.mockResolvedValue({ ok: true, path: '/tmp/x' });
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({ pluginId: 'pinned-game' }),
      }),
      {}
    );
    expect(res.status).toBe(200);
    expect(installPluginBundle).toHaveBeenCalledWith(
      'pinned-game',
      'https://cdn.example.dev/pinned-2.0.0.tgz',
      '2.0.0',
      { sha256: 'a'.repeat(64), sizeBytes: 4096 },
      null
    );
  });

  it('refuses an official plugin’s id with 409, whatever the catalogue says', async () => {
    getCatalogEntry.mockResolvedValue({
      pluginId: 'hushle', reviewStatus: 'approved', version: '9.0.0',
      manifestUrl: 'https://cdn.example.dev/hushle.tgz',
      bundleSha256: 'a'.repeat(64), bundleSizeBytes: 4096, id: 'h',
    });
    const { POST } = await import('../route.js');
    for (const pluginId of ['hushle', 'Dice-Bot']) {
      const res = await POST(
        new Request('https://example.test/api/marketplace/install', {
          method: 'POST',
          body: JSON.stringify({ pluginId }),
        }),
        {}
      );
      expect(res.status, pluginId).toBe(409);
      expect(((await res.json()) as { code?: string }).code).toBe('reserved_plugin_id');
    }
    expect(installPluginBundle).not.toHaveBeenCalled();
  });

  it('returns 403 when the plugin is not approved', async () => {
    getCatalogEntry.mockResolvedValue({
      pluginId: 'pending-game', reviewStatus: 'pending', id: 'y',
    });
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({ pluginId: 'pending-game' }),
      }),
      {}
    );
    expect(res.status).toBe(403);
    expect(installPluginBundle).not.toHaveBeenCalled();
  });

  it('returns 404 when the plugin is not in the catalog', async () => {
    getCatalogEntry.mockResolvedValue(null);
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({ pluginId: 'nope' }),
      }),
      {}
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when the plugin has no manifestUrl', async () => {
    getCatalogEntry.mockResolvedValue({
      pluginId: 'no-url', reviewStatus: 'approved', manifestUrl: null,
      bundleSha256: 'c'.repeat(64), bundleSizeBytes: 100, id: 'z',
    });
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({ pluginId: 'no-url' }),
      }),
      {}
    );
    expect(res.status).toBe(400);
  });

  it('returns 500 when the bundle download fails', async () => {
    getCatalogEntry.mockResolvedValue({
      pluginId: 'broken', version: '0.1.0', reviewStatus: 'approved',
      manifestUrl: 'https://cdn.example.dev/broken.tgz',
      bundleSha256: 'd'.repeat(64), bundleSizeBytes: 100, id: 'w',
    });
    installPluginBundle.mockResolvedValue({ ok: false, error: 'Download failed: HTTP 404' });
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({ pluginId: 'broken' }),
      }),
      {}
    );
    expect(res.status).toBe(500);
  });

  it('returns 503 when dynamic plugins are disabled (default)', async () => {
    vi.stubEnv('LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED', '');
    vi.resetModules();
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({ pluginId: 'cool-game' }),
      }),
      {}
    );
    expect(res.status).toBe(503);
  });

  describe('a bundle that asks for more than the sandbox', () => {
    const ENTRY = {
      pluginId: 'net-game', name: 'Net Game', version: '1.2.0',
      reviewStatus: 'approved', manifestUrl: 'https://cdn.example.dev/net-game-1.2.0.tgz',
      bundleSha256: 'c'.repeat(64), bundleSizeBytes: 1024, id: 'n',
    };
    const REQUESTED = { network: { connect: ['https://api.example.com'] }, permissions: ['timers'] };
    const post = async (body: unknown) => {
      const { POST } = await import('../route.js');
      return POST(new Request('https://example.test/api/marketplace/install', { method: 'POST', body: JSON.stringify(body) }), {});
    };

    it('answers 409 approval_required with what it asks for, and installs nothing', async () => {
      getCatalogEntry.mockResolvedValue(ENTRY);
      installPluginBundle.mockResolvedValue({
        ok: false,
        error: 'This plugin asks for access beyond the sandbox; the instance owner must approve it.',
        approvalRequired: { requested: REQUESTED, added: REQUESTED, previous: null },
      });
      const res = await post({ pluginId: 'net-game' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'approval_required', pluginId: 'net-game', version: '1.2.0',
        requested: REQUESTED, added: REQUESTED, previous: null,
      });
      expect(incrementDownloadCount).not.toHaveBeenCalled();
      expect(logAction).not.toHaveBeenCalled();
    });

    it('passes the owner’s approval to the installer, read with the manifest rules, and audits it', async () => {
      getCatalogEntry.mockResolvedValue(ENTRY);
      installPluginBundle.mockResolvedValue({ ok: true, path: '/x', approved: REQUESTED });
      const res = await post({ pluginId: 'net-game', approve: { permissions: ['timers'], network: { connect: ['https://api.example.com/'] } } });
      expect(res.status).toBe(200);
      expect(installPluginBundle.mock.calls[0]![4]).toEqual(REQUESTED);
      expect(await res.json()).toMatchObject({ ok: true, approved: REQUESTED });
      expect(logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'plugin.install', metadata: { version: '1.2.0', approved: REQUESTED },
      }));
    });

    it('refuses a malformed approval outright (400), before downloading anything', async () => {
      getCatalogEntry.mockResolvedValue(ENTRY);
      for (const approve of [{ network: { connect: ['https://localhost'] } }, ['timers'], { permissions: ['root'] }]) {
        const res = await post({ pluginId: 'net-game', approve });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'invalid_approval' });
      }
      expect(installPluginBundle).not.toHaveBeenCalled();
    });
  });

  it('rejects when admin token is missing', async () => {
    const denied = NextResponse.json({ error: 'Admin required' }, { status: 401 });
    requireAdminHealthToken.mockResolvedValue(denied);
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({ pluginId: 'cool-game' }),
      }),
      {}
    );
    expect(res.status).toBe(401);
  });
});
