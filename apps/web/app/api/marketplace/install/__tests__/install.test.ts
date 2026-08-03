import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireAdminHealthToken = vi.fn();
const getCatalogEntry = vi.fn();
const incrementDownloadCount = vi.fn();
const installPluginBundle = vi.fn();

vi.mock('@/lib/admin-auth', () => ({ requireAdminHealthToken }));
vi.mock('@lobbyforge/db', () => ({ getCatalogEntry, incrementDownloadCount }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/plugin-installer', () => ({ installPluginBundle }));

beforeEach(() => {
  vi.resetModules();
  requireAdminHealthToken.mockReset();
  getCatalogEntry.mockReset();
  incrementDownloadCount.mockReset();
  installPluginBundle.mockReset();
  requireAdminHealthToken.mockResolvedValue(null);
  incrementDownloadCount.mockResolvedValue(undefined);
});

describe('POST /api/marketplace/install', () => {
  it('installs an approved plugin with a manifestUrl', async () => {
    getCatalogEntry.mockResolvedValue({
      pluginId: 'cool-game', name: 'Cool Game', version: '1.0.0',
      reviewStatus: 'approved', manifestUrl: 'https://cdn.example.dev/cool-game-1.0.0.tgz',
      id: 'x',
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
    expect(installPluginBundle).toHaveBeenCalledWith('cool-game', 'https://cdn.example.dev/cool-game-1.0.0.tgz', '1.0.0');
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
      pluginId: 'no-url', reviewStatus: 'approved', manifestUrl: null, id: 'z',
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
      manifestUrl: 'https://cdn.example.dev/broken.tgz', id: 'w',
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
