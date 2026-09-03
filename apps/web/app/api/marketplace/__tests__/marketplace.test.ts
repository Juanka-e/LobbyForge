import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireMaterializedSession = vi.fn();
const requireAdminHealthToken = vi.fn();
const listApprovedPlugins = vi.fn();
const submitPluginForReview = vi.fn();
const reviewPlugin = vi.fn();

vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
vi.mock('@/lib/admin-auth', () => ({ requireAdminHealthToken }));
vi.mock('@lobbyforge/db', () => ({
  listApprovedPlugins,
  submitPluginForReview,
  reviewPlugin,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const UID = '00000000-0000-0000-0000-000000000099';

beforeEach(() => {
  vi.resetModules();
  requireMaterializedSession.mockReset();
  requireAdminHealthToken.mockReset();
  listApprovedPlugins.mockReset();
  submitPluginForReview.mockReset();
  reviewPlugin.mockReset();
  requireMaterializedSession.mockReturnValue({
    ok: true,
    session: { uid: UID, gid: 'g_1', name: 'Owner', exp: 123 },
  });
  requireAdminHealthToken.mockResolvedValue(null); // admin allowed
});

describe('GET /api/marketplace', () => {
  it('returns approved plugins with category + search filters', async () => {
    listApprovedPlugins.mockResolvedValue([
      {
        pluginId: 'trivia-bot', name: 'Trivia Bot', version: '1.0.0', type: 'game',
        summary: 'A trivia game bot', publisher: 'Alice', trustLevel: 'verified-community',
        category: 'game', tags: ['trivia', 'fun'], permissions: ['send_room_message'],
        playerConfig: { minPlayers: 2, maxPlayers: 20 }, iconUrl: null,
        requiresVoiceRoom: true, downloadCount: 42,
        id: 'x', description: null, publisherUserId: null, manifestUrl: null,
        reviewStatus: 'approved', reviewerUserId: null, reviewedAt: null, reviewNote: null,
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    const { GET } = await import('../route.js');
    const res = await GET(new Request('https://example.test/api/marketplace?category=game&q=trivia'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { plugins: Array<{ name: string }> };
    expect(json.plugins).toHaveLength(1);
    expect(json.plugins[0].name).toBe('Trivia Bot');
    expect(listApprovedPlugins).toHaveBeenCalledWith(
      { __mockDb: true },
      { category: 'game', search: 'trivia', limit: 50 }
    );
  });

  it('returns empty list when no plugins match', async () => {
    listApprovedPlugins.mockResolvedValue([]);
    const { GET } = await import('../route.js');
    const res = await GET(new Request('https://example.test/api/marketplace'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { plugins: unknown[] };
    expect(json.plugins).toEqual([]);
  });
});

describe('POST /api/marketplace/submit', () => {
  const validBody = {
    pluginId: 'my-awesome-game',
    name: 'My Awesome Game',
    version: '0.1.0',
    type: 'game' as const,
    publisher: 'DevDan',
    summary: 'The best game ever',
  };

  it('submits a plugin for review with pending status', async () => {
    submitPluginForReview.mockResolvedValue({
      pluginId: 'my-awesome-game', name: 'My Awesome Game',
      reviewStatus: 'pending', id: 'y',
    });
    const { POST } = await import('../submit/route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/submit', {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      {}
    );
    expect(res.status).toBe(201);
    expect(submitPluginForReview).toHaveBeenCalledWith(
      { __mockDb: true },
      expect.objectContaining({ pluginId: 'my-awesome-game', trustLevel: 'unverified' }),
      UID
    );
  });

  it('returns 401 when no session', async () => {
    requireMaterializedSession.mockReturnValue({
      ok: false,
      response: NextResponse.json({ error: 'Auth required' }, { status: 401 }),
    });
    const { POST } = await import('../submit/route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/submit', {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      {}
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 for an invalid type', async () => {
    const { POST } = await import('../submit/route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/submit', {
        method: 'POST',
        body: JSON.stringify({ ...validBody, type: 'bogus' }),
      }),
      {}
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/marketplace/review', () => {
  it('approves a plugin (admin)', async () => {
    reviewPlugin.mockResolvedValue(undefined);
    const { POST } = await import('../review/route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/review', {
        method: 'POST',
        body: JSON.stringify({ pluginId: 'my-awesome-game', decision: 'approved' }),
      }),
      {}
    );
    expect(res.status).toBe(200);
    expect(reviewPlugin).toHaveBeenCalledWith(
      { __mockDb: true },
      'my-awesome-game',
      'approved',
      expect.any(String),
      null
    );
  });

  it('rejects an invalid decision value', async () => {
    const { POST } = await import('../review/route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/review', {
        method: 'POST',
        body: JSON.stringify({ pluginId: 'x', decision: 'bogus' }),
      }),
      {}
    );
    expect(res.status).toBe(400);
  });

  it('returns the denied response when admin token is missing', async () => {
    const denied = NextResponse.json({ error: 'Admin required' }, { status: 401 });
    requireAdminHealthToken.mockResolvedValue(denied);
    const { POST } = await import('../review/route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/review', {
        method: 'POST',
        body: JSON.stringify({ pluginId: 'x', decision: 'approved' }),
      }),
      {}
    );
    expect(res.status).toBe(401);
    expect(reviewPlugin).not.toHaveBeenCalled();
  });
});

describe('POST /api/marketplace/submit — SEC-006 ownership', () => {
  it('maps PluginIdTakenError to 409 (ID takeover rejected as conflict)', async () => {
    const takeover = new Error('Plugin ID "hushle" is already published by another publisher.');
    takeover.name = 'PluginIdTakenError';
    submitPluginForReview.mockRejectedValueOnce(takeover);
    const { POST } = await import('../submit/route.js');
    const res = await POST(
      new Request('https://example.test/api/marketplace/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pluginId: 'hushle',
          name: 'Evil Clone',
          version: '1.0.0',
          type: 'game',
          publisher: 'Mallory',
        }),
      }),
      {}
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('another publisher');
  });
});
