import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireMaterializedSession = vi.fn();
const requireChannelInServer = vi.fn();
const setTyping = vi.fn();
const getTypingEntries = vi.fn();
const getBlockedUserIds = vi.fn();
const getBlockersAmong = vi.fn();
const getUserSettings = vi.fn();
const authorizeChannelMessageAccess = vi.fn();
const getActiveMemberTimeout = vi.fn();
const getServerMember = vi.fn();
const getUserById = vi.fn();

vi.mock('@/lib/api-auth', () => ({
  requireMaterializedSession,
  requireChannelInServer,
  requireVisibleChannelInServer: requireChannelInServer,
}));
vi.mock('@/lib/message-authorization', () => ({ authorizeChannelMessageAccess }));
vi.mock('@/lib/redis', () => ({ setTyping, getTypingEntries }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@lobbyforge/db', () => ({
  DEFAULT_USER_PRIVACY_SETTINGS: {
    profileVisibility: 'server_members',
    onlineStatusVisibility: 'server_members',
    activityVisibility: 'server_members',
    showCurrentGame: true,
    showMusicStatus: true,
    showWatchPartyStatus: true,
    showServerNameInActivity: true,
  },
  getBlockedUserIds,
  getBlockersAmong,
  getUserSettings,
  getActiveMemberTimeout,
  getServerMember,
  getUserById,
}));

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };
const SERVER_ID = '00000000-0000-0000-0000-000000000001';
const CHANNEL_ID = '00000000-0000-0000-0000-000000000002';
const UID = '00000000-0000-0000-0000-000000000099';
const ALICE = '00000000-0000-0000-0000-0000000000a1';
const BORA = '00000000-0000-0000-0000-0000000000b2';
const CEM = '00000000-0000-0000-0000-0000000000c3';

function privacy(onlineStatusVisibility: string) {
  return { privacy: { onlineStatusVisibility, activityVisibility: 'server_members' } };
}

beforeEach(() => {
  // The route reads the cookie via readGuestSession to resolve a display name.
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  vi.resetModules();
  requireMaterializedSession.mockReset();
  requireChannelInServer.mockReset();
  setTyping.mockReset();
  getTypingEntries.mockReset();
  getBlockedUserIds.mockReset().mockResolvedValue(new Set());
  getBlockersAmong.mockReset().mockResolvedValue(new Set());
  getUserSettings.mockReset().mockResolvedValue(null);
  requireMaterializedSession.mockReturnValue({
    ok: true,
    session: { uid: UID, gid: 'g_1', name: 'Owner', exp: 123 },
  });
  requireChannelInServer.mockResolvedValue({ ok: true });
  // POST: the message route's send check passes for a plain member.
  authorizeChannelMessageAccess.mockReset().mockResolvedValue({
    ok: true,
    context: { server: { id: SERVER_ID, ownerUserId: 'someone-else' }, channel: { id: CHANNEL_ID } },
  });
  getActiveMemberTimeout.mockReset().mockResolvedValue(null);
  getServerMember.mockReset().mockResolvedValue({ nickname: null });
  getUserById.mockReset().mockResolvedValue({ displayName: 'Profile Name' });
  setTyping.mockResolvedValue(undefined);
  getTypingEntries.mockResolvedValue([{ userId: ALICE, displayName: 'Alice' }]);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

function ctx() {
  return { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) };
}

async function getTypers(): Promise<{ status: number; typers: string[] }> {
  const { GET } = await import('../route.js');
  const res = await GET(
    new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/typing`),
    ctx()
  );
  return { status: res.status, typers: ((await res.json()) as { typers: string[] }).typers };
}

describe('POST /api/servers/[id]/channels/[channelId]/typing', () => {
  it('records the typing indicator and returns ok', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/typing`, {
        method: 'POST',
      }),
      ctx()
    );
    expect(res.status).toBe(200);
    expect(setTyping).toHaveBeenCalledWith(SERVER_ID, CHANNEL_ID, UID, expect.any(String));
  });

  it('returns the denied response when the channel does not belong to the server', async () => {
    authorizeChannelMessageAccess.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/typing`, {
        method: 'POST',
      }),
      ctx()
    );
    expect(res.status).toBe(403);
    expect(setTyping).not.toHaveBeenCalled();
  });
});

// Security review 2026-10 (A10): the typer's name came from the session
// cookie (no nickname, stale after a rename), and anyone who could SEE the
// channel could say they were typing — a timed-out member, or one without
// Send Messages, included.
describe('POST …/typing — who may type, under which name', () => {
  async function post(): Promise<Response> {
    const { POST } = await import('../route.js');
    return POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/typing`, { method: 'POST' }),
      ctx()
    );
  }

  it('asks the message route’s send check (membership, visibility, Send Messages)', async () => {
    await post();
    expect(authorizeChannelMessageAccess).toHaveBeenCalledWith({ userId: UID, serverId: SERVER_ID, channelId: CHANNEL_ID, operation: 'send' });
  });

  it('shows the community nickname first, then the account name — never the cookie’s name', async () => {
    getServerMember.mockResolvedValue({ nickname: 'Nick' });
    await post();
    expect(setTyping).toHaveBeenLastCalledWith(SERVER_ID, CHANNEL_ID, UID, 'Nick');
    getServerMember.mockResolvedValue({ nickname: null });
    await post();
    expect(setTyping).toHaveBeenLastCalledWith(SERVER_ID, CHANNEL_ID, UID, 'Profile Name');
  });

  it('a member without Send Messages records nothing (403)', async () => {
    authorizeChannelMessageAccess.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    expect((await post()).status).toBe(403);
    expect(setTyping).not.toHaveBeenCalled();
  });

  it('a timed-out member records nothing (403 actor_timed_out)', async () => {
    const until = new Date(Date.now() + 60_000);
    getActiveMemberTimeout.mockResolvedValue(until);
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'actor_timed_out', until: until.toISOString() });
    expect(getActiveMemberTimeout).toHaveBeenCalledWith({ __mockDb: true }, SERVER_ID, UID);
    expect(setTyping).not.toHaveBeenCalled();
  });
});

describe('GET /api/servers/[id]/channels/[channelId]/typing', () => {
  it('returns the list of currently-typing users', async () => {
    expect(await getTypers()).toEqual({ status: 200, typers: ['Alice'] });
  });

  it('falls back to an empty typers list when the typing store throws', async () => {
    getTypingEntries.mockRejectedValue(new Error('redis down'));
    expect(await getTypers()).toEqual({ status: 200, typers: [] });
  });

  it('never lists the viewer, and asks the database nothing when nobody else types', async () => {
    getTypingEntries.mockResolvedValue([{ userId: UID, displayName: 'Owner' }]);
    expect((await getTypers()).typers).toEqual([]);
    expect(getBlockedUserIds).not.toHaveBeenCalled();
    expect(getUserSettings).not.toHaveBeenCalled();
  });
});

// Security review (needs verification #4): typers came back without the
// block list or online-status privacy — the presence routes apply both.
describe('GET …/typing — blocks and online-status privacy', () => {
  beforeEach(() => {
    getTypingEntries.mockResolvedValue([
      { userId: ALICE, displayName: 'Alice' },
      { userId: BORA, displayName: 'Bora' },
      { userId: CEM, displayName: 'Cem' },
    ]);
  });

  it('leaves out a user the viewer blocked', async () => {
    getBlockedUserIds.mockResolvedValue(new Set([BORA]));
    expect((await getTypers()).typers).toEqual(['Alice', 'Cem']);
  });

  it('leaves out a user who blocked the viewer (asking only about the typers)', async () => {
    getBlockersAmong.mockResolvedValue(new Set([CEM]));
    expect((await getTypers()).typers).toEqual(['Alice', 'Bora']);
    expect(getBlockersAmong).toHaveBeenCalledWith({ __mockDb: true }, UID, [ALICE, BORA, CEM]);
  });

  it("leaves out a user whose online status is hidden from the viewer ('nobody', 'friends')", async () => {
    getUserSettings.mockImplementation(async (_db: unknown, userId: string) =>
      userId === ALICE ? privacy('nobody') : userId === BORA ? privacy('friends') : privacy('everyone')
    );
    expect((await getTypers()).typers).toEqual(['Cem']);
  });

  it("keeps a user who shows their status to server members (the default)", async () => {
    getUserSettings.mockImplementation(async (_db: unknown, userId: string) =>
      userId === ALICE ? privacy('server_members') : null
    );
    expect((await getTypers()).typers).toEqual(['Alice', 'Bora', 'Cem']);
  });
});
