import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

const mockRequireServerMember = vi.fn();
const mockRequireChannelInServer = vi.fn();
const mockRequireServerPermission = vi.fn();
const mockLogAction = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  logAction: (...args: unknown[]) => mockLogAction(...args),
}));

vi.mock('@/lib/api-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-auth')>('@/lib/api-auth');
  return {
    ...actual,
    requireServerMember: (...args: unknown[]) => mockRequireServerMember(...args),
    requireChannelInServer: (...args: unknown[]) => mockRequireChannelInServer(...args),
    requireVisibleChannelInServer: (...args: unknown[]) => mockRequireChannelInServer(...args.slice(1)),
    requireServerPermission: (...args: unknown[]) => mockRequireServerPermission(...args),
  };
});

// Mock LiveKit
const mockListParticipants = vi.fn();
const mockMutePublishedTrack = vi.fn();

vi.mock('@/lib/livekit', () => ({
  getRoomServiceClient: () => ({
    listParticipants: (...args: unknown[]) => mockListParticipants(...args),
    mutePublishedTrack: (...args: unknown[]) => mockMutePublishedTrack(...args),
  }),
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
}));

vi.mock('@/lib/db', () => ({
  getDb: () => ({ __mockDbClient: true }),
}));

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  mockRequireServerMember.mockReset();
  mockRequireChannelInServer.mockReset();
  mockRequireServerPermission.mockReset();
  mockRequireServerMember.mockResolvedValue({ ok: true, server: { id: SERVER_ID } });
  mockRequireChannelInServer.mockResolvedValue({
    ok: true,
    channel: { id: CHANNEL_ID, serverId: SERVER_ID, type: 'voice' },
  });
  mockRequireServerPermission.mockResolvedValue({ ok: true, permissions: ['mute_members'] });
  mockLogAction.mockReset();
  mockLogAction.mockResolvedValue(undefined);
  mockListParticipants.mockReset();
  mockMutePublishedTrack.mockReset();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

function makeSessionCookie(uid: string = 'user-mod'): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Moderator' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

async function loadRoute() {
  return import('../route.js');
}

const SERVER_ID = '00000000-0000-0000-0000-000000000001';
const CHANNEL_ID = '00000000-0000-0000-0000-000000000010';
const TARGET_ID = '00000000-0000-0000-0000-000000000020';
const ROOM = 's_00000000000000000000000000000001_c_00000000000000000000000000000010';

describe('POST /api/servers/{id}/channels/{channelId}/members/{userId}/voice/mute', () => {
  it('returns 403 when the caller lacks MUTE_MEMBERS', async () => {
    mockRequireServerPermission.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
    });
    const { POST } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/members/${TARGET_ID}/voice/mute`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted: true }),
    });
    const res = await POST(req, {
      params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, userId: TARGET_ID }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 when the participant is not in the room', async () => {
    mockListParticipants.mockResolvedValue([]);
    const { POST } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/members/${TARGET_ID}/voice/mute`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted: true }),
    });
    const res = await POST(req, {
      params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, userId: TARGET_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('mutes the participant when authorized and in room', async () => {
    mockListParticipants.mockResolvedValue([
      {
        identity: TARGET_ID,
        tracks: [
          { sid: 'track-mic', type: 0, source: 1 }, // AUDIO=0, MICROPHONE=1
        ],
      },
    ]);
    mockMutePublishedTrack.mockResolvedValue({});
    const { POST } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/members/${TARGET_ID}/voice/mute`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted: true }),
    });
    const res = await POST(req, {
      params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, userId: TARGET_ID }),
    });
    expect(res.status).toBe(200);
    expect(mockListParticipants).toHaveBeenCalledWith(ROOM);
    expect(mockMutePublishedTrack).toHaveBeenCalledWith(ROOM, TARGET_ID, 'track-mic', true);
  });

  it('rejects client supplied room names instead of trusting them', async () => {
    const { POST } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/members/${TARGET_ID}/voice/mute`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted: true, room: 'attacker-room' }),
    });
    const res = await POST(req, {
      params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, userId: TARGET_ID }),
    });
    expect(res.status).toBe(400);
    expect(mockListParticipants).not.toHaveBeenCalled();
  });
});
