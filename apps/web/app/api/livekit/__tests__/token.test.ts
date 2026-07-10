import { beforeEach, describe, expect, it, vi } from 'vitest';

const issueLiveKitToken = vi.fn().mockResolvedValue('token-1');
const requireLiveKitCredentials = vi.fn(() => ({ apiKey: 'key', apiSecret: 'secret' }));
const requireMaterializedSession = vi.fn();
const requireServerMember = vi.fn();
const requireChannelInServer = vi.fn();
const requireServerPermission = vi.fn();
const getEffectiveServerVoiceSettings = vi.fn();

vi.mock('@/lib/livekit', () => ({
  LIVEKIT_TOKEN_TTL_SECONDS: 3600,
  issueLiveKitToken,
  requireLiveKitCredentials,
}));

vi.mock('@/lib/api-auth', () => ({
  CorePermission: { CONNECT_VOICE: 'connect_voice' },
  requireMaterializedSession,
  requireServerMember,
  requireChannelInServer,
  requireServerPermission,
}));

vi.mock('@lobbyforge/db', () => ({
  getEffectiveServerVoiceSettings,
}));

vi.mock('@/lib/db', () => ({
  getDb: () => ({ __mockDb: true }),
}));

vi.mock('@/lib/livekit-room', () => ({
  liveKitRoomName: (serverId: string, channelId: string) => `lf-${serverId}-${channelId}`,
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
}));

const SERVER_ID = '00000000-0000-0000-0000-000000000001';
const CHANNEL_ID = '00000000-0000-0000-0000-000000000002';

async function loadRoute() {
  return import('../token/route.js');
}

function makeRequest(body: Record<string, unknown>) {
  return new Request('https://example.test/api/livekit/token', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetModules();
  issueLiveKitToken.mockClear();
  requireLiveKitCredentials.mockClear();
  requireMaterializedSession.mockReset();
  requireServerMember.mockReset();
  requireChannelInServer.mockReset();
  requireServerPermission.mockReset();
  getEffectiveServerVoiceSettings.mockReset();

  requireMaterializedSession.mockReturnValue({
    ok: true,
    session: {
      uid: '00000000-0000-0000-0000-000000000099',
      gid: 'g_1',
      name: 'Owner',
      exp: 123,
    },
  });
  requireServerMember.mockResolvedValue({ ok: true });
  requireChannelInServer.mockResolvedValue({ ok: true, channel: { type: 'voice' } });
  requireServerPermission.mockResolvedValue({ ok: true });
  getEffectiveServerVoiceSettings.mockResolvedValue({
    allowCamera: true,
    allowScreenShare: true,
  });
});

describe('POST /api/livekit/token voice media policy', () => {
  it('allows microphone, camera, and screen share by default', async () => {
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ serverId: SERVER_ID, channelId: CHANNEL_ID }), {});
    expect(res.status).toBe(200);
    expect(issueLiveKitToken).toHaveBeenCalledWith(
      expect.objectContaining({
        grants: expect.objectContaining({
          canPublishSources: ['microphone', 'camera', 'screen-share', 'screen-share-audio'],
        }),
      })
    );
  });

  it('removes camera and screen share sources when disabled by server settings', async () => {
    getEffectiveServerVoiceSettings.mockResolvedValue({
      allowCamera: false,
      allowScreenShare: false,
    });
    const { POST } = await loadRoute();
    const res = await POST(
      makeRequest({
        serverId: SERVER_ID,
        channelId: CHANNEL_ID,
        canPublishSources: ['microphone', 'camera', 'screen-share', 'screen-share-audio'],
      }),
      {}
    );
    expect(res.status).toBe(200);
    expect(issueLiveKitToken).toHaveBeenCalledWith(
      expect.objectContaining({
        grants: expect.objectContaining({
          canPublishSources: ['microphone'],
        }),
      })
    );
  });
});
