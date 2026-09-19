import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

const mockRequireServerMember = vi.fn();
const mockRequireChannelInServer = vi.fn();
const mockRequireServerPermission = vi.fn();
const mockLogAction = vi.fn();

const mockSetMemberVoiceMuted = vi.fn();
vi.mock('@lobbyforge/db', () => ({
  logAction: (...args: unknown[]) => mockLogAction(...args),
  setMemberVoiceMuted: (...args: unknown[]) => mockSetMemberVoiceMuted(...args),
}));

const mockSyncMemberVoiceAccess = vi.fn();
vi.mock('@/lib/voice-moderation', () => ({
  syncMemberVoiceAccess: (...args: unknown[]) => mockSyncMemberVoiceAccess(...args),
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


vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
}));

// 10th-audit: the route now goes through the canonical moderation
// hierarchy gate (voice_mute op).
const mockAuthorizeModerationTarget = vi.fn();
vi.mock('@/lib/member-authorization', () => ({
  authorizeModerationTarget: (...args: unknown[]) => mockAuthorizeModerationTarget(...args),
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
  mockAuthorizeModerationTarget.mockReset().mockResolvedValue({ ok: true, context: { server: { ownerUserId: 'owner' }, actorHighest: 100 } });
  mockRequireServerMember.mockResolvedValue({ ok: true, server: { id: SERVER_ID } });
  mockRequireChannelInServer.mockResolvedValue({
    ok: true,
    channel: { id: CHANNEL_ID, serverId: SERVER_ID, type: 'voice' },
  });
  mockRequireServerPermission.mockResolvedValue({ ok: true, permissions: ['mute_members'] });
  mockLogAction.mockReset();
  mockLogAction.mockResolvedValue(undefined);
  mockSetMemberVoiceMuted.mockReset().mockResolvedValue(true);
  mockSyncMemberVoiceAccess.mockReset().mockResolvedValue(undefined);
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

describe('POST /api/servers/{id}/channels/{channelId}/members/{userId}/voice/mute', () => {
  it('returns 403 when the caller lacks MUTE_MEMBERS (enforced by the hierarchy gate)', async () => {
    mockAuthorizeModerationTarget.mockResolvedValue({
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

  function muteRequest(body: Record<string, unknown>) {
    return new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/members/${TARGET_ID}/voice/mute`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  const params = { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, userId: TARGET_ID }) };

  it('beta-review: persists the mute and enforces it live in LiveKit', async () => {
    const { POST } = await loadRoute();
    const res = await POST(muteRequest({ muted: true }), params);
    expect(res.status).toBe(200);
    expect(mockSetMemberVoiceMuted).toHaveBeenCalledWith(expect.anything(), SERVER_ID, TARGET_ID, true);
    expect(mockSyncMemberVoiceAccess).toHaveBeenCalledWith(SERVER_ID, TARGET_ID);
    expect(mockSetMemberVoiceMuted.mock.invocationCallOrder[0]).toBeLessThan(
      mockSyncMemberVoiceAccess.mock.invocationCallOrder[0]!
    );
  });

  it('beta-review: a member who is not in voice (no mic track) can still be muted ahead of time', async () => {
    mockSyncMemberVoiceAccess.mockResolvedValue(undefined); // nothing connected
    const { POST } = await loadRoute();
    const res = await POST(muteRequest({ muted: true }), params);
    expect(res.status).toBe(200);
  });

  it('beta-review: lifting the mute only re-syncs permissions (never unmutes a track remotely)', async () => {
    const { POST } = await loadRoute();
    const res = await POST(muteRequest({ muted: false }), params);
    expect(res.status).toBe(200);
    expect(mockSetMemberVoiceMuted).toHaveBeenCalledWith(expect.anything(), SERVER_ID, TARGET_ID, false);
    expect(mockSyncMemberVoiceAccess).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the target is not a member', async () => {
    mockSetMemberVoiceMuted.mockResolvedValue(false);
    const { POST } = await loadRoute();
    const res = await POST(muteRequest({ muted: true }), params);
    expect(res.status).toBe(404);
    expect(mockSyncMemberVoiceAccess).not.toHaveBeenCalled();
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
    expect(mockSetMemberVoiceMuted).not.toHaveBeenCalled();
  });
});
