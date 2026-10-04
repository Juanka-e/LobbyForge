/**
 * Moderator "Disconnect from voice": MUTE_MEMBERS + the hierarchy gate,
 * then RemoveParticipant on that channel's room and a `voice.disconnect`
 * audit row — and NOTHING that would keep the person out (no voice block,
 * no token refusal). The gate itself runs for real here, over a mocked
 * database, so the permission / rank / owner / self rules are exercised
 * end to end rather than stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

const db = vi.hoisted(() => ({
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  getUserPermissions: vi.fn(),
  getHighestRolePosition: vi.fn(),
  userExists: vi.fn(),
  logAction: vi.fn(),
}));
vi.mock('@lobbyforge/db', () => db);

const removeParticipant = vi.fn();
const getRoomServiceClient = vi.fn(() => ({ removeParticipant }));
vi.mock('@/lib/livekit', () => ({ getRoomServiceClient: () => getRoomServiceClient() }));

const requireVisibleChannelInServer = vi.fn();
vi.mock('@/lib/api-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-auth')>('@/lib/api-auth');
  return { ...actual, requireVisibleChannelInServer: (...args: unknown[]) => requireVisibleChannelInServer(...args) };
});

// The anti-cheat block must never be touched by a moderator disconnect.
const blockVoice = vi.fn();
const isVoiceBlocked = vi.fn();
const getVoiceBlock = vi.fn();
vi.mock('@/lib/voice-block', () => ({ blockVoice, isVoiceBlocked, getVoiceBlock }));

vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };

const SERVER_ID = '00000000-0000-4000-8000-000000000001';
const CHANNEL_ID = '00000000-0000-4000-8000-000000000010';
const OWNER_ID = '00000000-0000-4000-8000-0000000000ff';
const MOD_ID = '00000000-0000-4000-8000-000000000030';
const TARGET_ID = '00000000-0000-4000-8000-000000000020';
const ROOM = `s_${SERVER_ID.replaceAll('-', '')}_c_${CHANNEL_ID.replaceAll('-', '')}`;

function cookieFor(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Moderator' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

async function disconnect(options: { actor?: string; target?: string; body?: string } = {}): Promise<Response> {
  const { POST } = await import('../route');
  const target = options.target ?? TARGET_ID;
  return POST(
    new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/members/${target}/voice/disconnect`, {
      method: 'POST',
      headers: { cookie: cookieFor(options.actor ?? MOD_ID), 'Content-Type': 'application/json' },
      ...(options.body !== undefined ? { body: options.body } : {}),
    }),
    { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, userId: target }) }
  );
}

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(db)) fn.mockReset();
  db.getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER_ID });
  db.isServerMember.mockResolvedValue(true);
  db.getUserPermissions.mockResolvedValue(['mute_members']);
  db.getHighestRolePosition.mockImplementation(async (_db: unknown, _server: string, userId: string) =>
    userId === MOD_ID ? 50 : 10
  );
  db.logAction.mockResolvedValue(undefined);
  removeParticipant.mockReset().mockResolvedValue(undefined);
  getRoomServiceClient.mockClear();
  requireVisibleChannelInServer.mockReset().mockResolvedValue({
    ok: true,
    channel: { id: CHANNEL_ID, serverId: SERVER_ID, type: 'voice' },
  });
  blockVoice.mockReset();
  isVoiceBlocked.mockReset();
  getVoiceBlock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  Object.assign(process.env, envSnapshot);
});

function expectNothingDone() {
  expect(removeParticipant).not.toHaveBeenCalled();
  expect(db.logAction).not.toHaveBeenCalled();
}

describe('POST …/members/{userId}/voice/disconnect', () => {
  it('removes the member from THAT channel’s room and audits it as the moderator', async () => {
    const res = await disconnect();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(removeParticipant).toHaveBeenCalledTimes(1);
    expect(removeParticipant).toHaveBeenCalledWith(ROOM, TARGET_ID);
    expect(db.logAction).toHaveBeenCalledWith(
      { __mockDb: true },
      {
        serverId: SERVER_ID,
        actorUserId: MOD_ID,
        action: 'voice.disconnect',
        targetType: 'user',
        targetId: TARGET_ID,
        metadata: { channelId: CHANNEL_ID },
      }
    );
  });

  it('never blocks the member from voice: they can rejoin at once', async () => {
    expect((await disconnect()).status).toBe(200);
    expect(blockVoice).not.toHaveBeenCalled();
    expect(isVoiceBlocked).not.toHaveBeenCalled();
    expect(getVoiceBlock).not.toHaveBeenCalled();
  });

  it('accepts an empty JSON object as the body', async () => {
    expect((await disconnect({ body: '{}' })).status).toBe(200);
    expect(removeParticipant).toHaveBeenCalledWith(ROOM, TARGET_ID);
  });

  it('refuses a body that names a room instead of trusting it', async () => {
    const res = await disconnect({ body: JSON.stringify({ room: 'attacker-room' }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_request' });
    expectNothingDone();
  });

  it('403 forbidden without MUTE_MEMBERS', async () => {
    db.getUserPermissions.mockResolvedValue(['connect_voice', 'kick_members']);
    const res = await disconnect();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'forbidden' });
    expectNothingDone();
  });

  it('403 insufficient_rank when the target ranks equal or above the moderator', async () => {
    db.getHighestRolePosition.mockResolvedValue(50);
    const res = await disconnect();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'insufficient_rank' });
    expectNothingDone();
  });

  it('403 target_is_owner: nobody disconnects the owner', async () => {
    db.getUserPermissions.mockResolvedValue(['administrator']);
    const res = await disconnect({ target: OWNER_ID });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'target_is_owner' });
    expectNothingDone();
  });

  it('400 self_action: leaving is the client’s own Disconnect button', async () => {
    const res = await disconnect({ target: MOD_ID });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'self_action' });
    expectNothingDone();
  });

  it('the owner may disconnect anyone else, whatever their rank', async () => {
    db.getHighestRolePosition.mockResolvedValue(99);
    expect((await disconnect({ actor: OWNER_ID })).status).toBe(200);
    expect(removeParticipant).toHaveBeenCalledWith(ROOM, TARGET_ID);
  });

  it('404 target_not_member for someone who is not a member', async () => {
    db.isServerMember.mockImplementation(async (_db: unknown, userId: string) => userId !== TARGET_ID);
    const res = await disconnect();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'target_not_member' });
    expectNothingDone();
  });

  it('404 not_in_voice when LiveKit has no such participant in the room', async () => {
    removeParticipant.mockRejectedValueOnce(Object.assign(new Error('participant not found'), { status: 404, code: 'not_found' }));
    const res = await disconnect();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_in_voice' });
    expect(db.logAction).not.toHaveBeenCalled();
  });

  it('503 voice_unavailable when LiveKit cannot be reached, without an audit row', async () => {
    removeParticipant.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { status: 0 }));
    const res = await disconnect();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'voice_unavailable' });
    expect(db.logAction).not.toHaveBeenCalled();
  });

  it('503 voice_unavailable when LiveKit is not configured', async () => {
    getRoomServiceClient.mockImplementationOnce(() => {
      throw new Error('requireLiveKitCredentials: LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set');
    });
    const res = await disconnect();
    expect(res.status).toBe(503);
    expectNothingDone();
  });

  it('400 not_voice_channel for a text channel', async () => {
    requireVisibleChannelInServer.mockResolvedValue({
      ok: true,
      channel: { id: CHANNEL_ID, serverId: SERVER_ID, type: 'text' },
    });
    const res = await disconnect();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'not_voice_channel' });
    expectNothingDone();
  });

  it('passes on the channel gate’s refusal (not a member, hidden channel, …)', async () => {
    requireVisibleChannelInServer.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
    });
    expect((await disconnect()).status).toBe(403);
    expect(requireVisibleChannelInServer).toHaveBeenCalledWith(MOD_ID, CHANNEL_ID, SERVER_ID);
    expectNothingDone();
  });

  it('401 without a session', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/members/${TARGET_ID}/voice/disconnect`, {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, userId: TARGET_ID }) }
    );
    expect(res.status).toBe(401);
    expectNothingDone();
  });

  it('still answers 200 when the audit write fails (the removal already happened)', async () => {
    db.logAction.mockRejectedValueOnce(new Error('db down'));
    expect((await disconnect()).status).toBe(200);
    expect(removeParticipant).toHaveBeenCalledTimes(1);
  });
});
