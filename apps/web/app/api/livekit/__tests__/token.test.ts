import { beforeEach, describe, expect, it, vi } from 'vitest';

const issueLiveKitToken = vi.fn().mockResolvedValue('token-1');
const requireLiveKitCredentials = vi.fn(() => ({ apiKey: 'key', apiSecret: 'secret' }));
const listParticipants = vi.fn();
const requireMaterializedSession = vi.fn();
const requireServerMember = vi.fn();
const requireChannelInServer = vi.fn();
const requireServerPermission = vi.fn();
const getEffectiveServerVoiceSettings = vi.fn();

vi.mock('@/lib/livekit', () => ({
  LIVEKIT_TOKEN_TTL_SECONDS: 3600,
  issueLiveKitToken,
  requireLiveKitCredentials,
  getRoomServiceClient: () => ({ listParticipants }),
}));

vi.mock('livekit-server-sdk', () => ({
  TrackSource: { CAMERA: 1, MICROPHONE: 2, SCREEN_SHARE: 3, SCREEN_SHARE_AUDIO: 4 },
}));

vi.mock('@/lib/api-auth', () => ({
  CorePermission: {
    CONNECT_VOICE: 'connect_voice',
    SPEAK: 'speak',
    STREAM: 'stream',
  },
  hasPermission: (perms: string[], required: string) => perms.includes(required),
  requireMaterializedSession,
  requireServerMember,
  requireChannelInServer,
  requireVisibleChannelInServer: requireChannelInServer,
  requireServerPermission,
}));

const getUserPermissions = vi.fn();
const getActiveMemberTimeout = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  getEffectiveServerVoiceSettings,
  getUserPermissions,
  getActiveMemberTimeout,
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
  listParticipants.mockReset();
  requireMaterializedSession.mockReset();
  requireServerMember.mockReset();
  requireChannelInServer.mockReset();
  requireServerPermission.mockReset();
  getEffectiveServerVoiceSettings.mockReset();
  getUserPermissions.mockReset();
  getActiveMemberTimeout.mockReset();
  // Full baseline member by default (all publish sources allowed).
  getUserPermissions.mockResolvedValue(['connect_voice', 'speak', 'stream']);
  getActiveMemberTimeout.mockResolvedValue(null);

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
  // No limits configured by default → listParticipants is not called.
  getEffectiveServerVoiceSettings.mockResolvedValue({
    allowCamera: true,
    allowScreenShare: true,
    requirePushToTalk: false,
    startMuted: false,
    defaultUserLimit: null,
    maxCameraUsersPerRoom: null,
    maxScreenShareUsersPerRoom: null,
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

describe('POST /api/livekit/token role-gated publish sources', () => {
  it('strips the microphone when the member lacks SPEAK (listen-only)', async () => {
    getUserPermissions.mockResolvedValue(['connect_voice', 'stream']);
    const { POST } = await loadRoute();
    const res = await POST(
      makeRequest({
        serverId: SERVER_ID,
        channelId: CHANNEL_ID,
        canPublishSources: ['microphone', 'camera'],
      }),
      {}
    );
    expect(res.status).toBe(200);
    expect(issueLiveKitToken).toHaveBeenCalledWith(
      expect.objectContaining({
        grants: expect.objectContaining({ canPublishSources: ['camera'] }),
      })
    );
  });

  it('strips camera AND screen-share when the member lacks STREAM', async () => {
    getUserPermissions.mockResolvedValue(['connect_voice', 'speak']);
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
        grants: expect.objectContaining({ canPublishSources: ['microphone'] }),
      })
    );
  });

  it('a timed-out member keeps listen access but loses the microphone', async () => {
    getUserPermissions.mockResolvedValue(['connect_voice', 'speak', 'stream']);
    getActiveMemberTimeout.mockResolvedValue(new Date(Date.now() + 60_000));
    const { POST } = await loadRoute();
    const res = await POST(
      makeRequest({
        serverId: SERVER_ID,
        channelId: CHANNEL_ID,
        canPublishSources: ['microphone', 'screen-share'],
      }),
      {}
    );
    expect(res.status).toBe(200);
    // Timeout mutes the person; streaming stays available.
    expect(issueLiveKitToken).toHaveBeenCalledWith(
      expect.objectContaining({
        grants: expect.objectContaining({ canPublishSources: ['screen-share'] }),
      })
    );
  });
});

describe('POST /api/livekit/token room limits', () => {
  it('rejects with 409 when the voice room is at defaultUserLimit', async () => {
    getEffectiveServerVoiceSettings.mockResolvedValue({
      allowCamera: true,
      allowScreenShare: true,
      requirePushToTalk: false,
      startMuted: false,
      defaultUserLimit: 5,
      maxCameraUsersPerRoom: null,
      maxScreenShareUsersPerRoom: null,
    });
    listParticipants.mockResolvedValue([
      { identity: 'a' },
      { identity: 'b' },
      { identity: 'c' },
      { identity: 'd' },
      { identity: 'e' },
    ]);
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ serverId: SERVER_ID, channelId: CHANNEL_ID }), {});
    expect(res.status).toBe(409);
    expect(issueLiveKitToken).not.toHaveBeenCalled();
  });

  it('drops camera from canPublishSources when maxCameraUsersPerRoom is reached', async () => {
    getEffectiveServerVoiceSettings.mockResolvedValue({
      allowCamera: true,
      allowScreenShare: true,
      requirePushToTalk: false,
      startMuted: false,
      defaultUserLimit: null,
      maxCameraUsersPerRoom: 2,
      maxScreenShareUsersPerRoom: null,
    });
    listParticipants.mockResolvedValue([
      { identity: 'a', tracks: [{ source: 1 }] }, // CAMERA
      { identity: 'b', tracks: [{ source: 1 }] }, // CAMERA
      { identity: 'c', tracks: [{ source: 2 }] }, // MICROPHONE only
    ]);
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ serverId: SERVER_ID, channelId: CHANNEL_ID }), {});
    expect(res.status).toBe(200);
    expect(issueLiveKitToken).toHaveBeenCalledWith(
      expect.objectContaining({
        grants: expect.objectContaining({
          // camera dropped because 2 camera publishers already in room
          canPublishSources: ['microphone', 'screen-share', 'screen-share-audio'],
        }),
      })
    );
  });

  it('fails open (still mints token) when listParticipants throws', async () => {
    getEffectiveServerVoiceSettings.mockResolvedValue({
      allowCamera: true,
      allowScreenShare: true,
      requirePushToTalk: false,
      startMuted: false,
      defaultUserLimit: 5,
      maxCameraUsersPerRoom: null,
      maxScreenShareUsersPerRoom: null,
    });
    listParticipants.mockRejectedValue(new Error('LiveKit unreachable'));
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ serverId: SERVER_ID, channelId: CHANNEL_ID }), {});
    expect(res.status).toBe(200);
    expect(issueLiveKitToken).toHaveBeenCalled();
  });

  it('returns serverVoiceSettings (requirePushToTalk + startMuted) in the response', async () => {
    getEffectiveServerVoiceSettings.mockResolvedValue({
      allowCamera: true,
      allowScreenShare: true,
      requirePushToTalk: true,
      startMuted: true,
      defaultUserLimit: null,
      maxCameraUsersPerRoom: null,
      maxScreenShareUsersPerRoom: null,
    });
    const { POST } = await loadRoute();
    const res = await POST(makeRequest({ serverId: SERVER_ID, channelId: CHANNEL_ID }), {});
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.serverVoiceSettings).toEqual({ requirePushToTalk: true, startMuted: true });
  });
});
