import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireMaterializedSession = vi.fn();
const requireServerMember = vi.fn();
const requireServerPermission = vi.fn();
const getEffectiveServerVoiceSettings = vi.fn();
const updateServerVoiceSettings = vi.fn();

vi.mock('@/lib/api-auth', () => ({
  CorePermission: { MANAGE_SERVER: 'manage_server' },
  requireMaterializedSession,
  requireServerMember,
  requireServerPermission,
}));
vi.mock('@lobbyforge/db', () => ({
  getEffectiveServerVoiceSettings,
  updateServerVoiceSettings,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

async function loadRoute() {
  return import('../route.js');
}

const SERVER_ID = '00000000-0000-0000-0000-000000000001';
const UID = '00000000-0000-0000-0000-000000000099';

const sampleRow = {
  serverId: SERVER_ID,
  defaultUserLimit: null,
  requirePushToTalk: false,
  startMuted: false,
  allowCamera: true,
  allowScreenShare: true,
  maxCameraUsersPerRoom: null,
  maxScreenShareUsersPerRoom: null,
  maxScreenShareHeight: 1080,
  maxScreenShareFps: 30,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

beforeEach(() => {
  vi.resetModules();
  requireMaterializedSession.mockReset();
  requireServerMember.mockReset();
  requireServerPermission.mockReset();
  getEffectiveServerVoiceSettings.mockReset();
  updateServerVoiceSettings.mockReset();
  // Defaults: member access allowed.
  requireMaterializedSession.mockReturnValue({
    ok: true,
    session: { uid: UID, gid: 'g_1', name: 'Owner', exp: 123 },
  });
  requireServerMember.mockResolvedValue({ ok: true });
  requireServerPermission.mockResolvedValue({ ok: true });
});

function ctx(id = SERVER_ID) {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/servers/[id]/voice-settings', () => {
  it('returns the effective settings for a member', async () => {
    getEffectiveServerVoiceSettings.mockResolvedValue(sampleRow);
    const { GET } = await loadRoute();
    const res = await GET(new Request(`https://example.test/api/servers/${SERVER_ID}/voice-settings`), ctx());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { settings: { serverId: string } };
    expect(json.settings.serverId).toBe(SERVER_ID);
  });

  it('returns the denied response when the caller is not a member', async () => {
    requireServerMember.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const { GET } = await loadRoute();
    const res = await GET(new Request(`https://example.test/api/servers/${SERVER_ID}/voice-settings`), ctx());
    expect(res.status).toBe(403);
    expect(getEffectiveServerVoiceSettings).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/servers/[id]/voice-settings', () => {
  it('persists a valid partial body and returns the updated settings', async () => {
    const updated = { ...sampleRow, requirePushToTalk: true, maxCameraUsersPerRoom: 5 };
    updateServerVoiceSettings.mockResolvedValue(updated);
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      new Request(`https://example.test/api/servers/${SERVER_ID}/voice-settings`, {
        method: 'PATCH',
        body: JSON.stringify({ requirePushToTalk: true, maxCameraUsersPerRoom: 5 }),
      }),
      ctx()
    );
    expect(res.status).toBe(200);
    expect(updateServerVoiceSettings).toHaveBeenCalledWith(
      { __mockDb: true },
      SERVER_ID,
      expect.objectContaining({ requirePushToTalk: true })
    );
  });

  it('returns 403 when the caller lacks MANAGE_SERVER permission', async () => {
    requireServerPermission.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      new Request(`https://example.test/api/servers/${SERVER_ID}/voice-settings`, {
        method: 'PATCH',
        body: JSON.stringify({ requirePushToTalk: true }),
      }),
      ctx()
    );
    expect(res.status).toBe(403);
    expect(updateServerVoiceSettings).not.toHaveBeenCalled();
  });

  it('returns 400 for an out-of-range limit', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(
      new Request(`https://example.test/api/servers/${SERVER_ID}/voice-settings`, {
        method: 'PATCH',
        body: JSON.stringify({ defaultUserLimit: 99999 }),
      }),
      ctx()
    );
    expect(res.status).toBe(400);
  });
});
