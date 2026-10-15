import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireMaterializedSession = vi.fn();
const listDmChannelsForUser = vi.fn();
const findOrCreateDmChannel = vi.fn();
const getBlockedUserIds = vi.fn();
const isDmChannelParticipant = vi.fn();
const checkDmChannelAccess = vi.fn();
const listDmMessages = vi.fn();
const sendDmMessage = vi.fn();
const getDmRecipientEligibility = vi.fn();

vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
vi.mock('@lobbyforge/db', () => ({
  listDmChannelsForUser,
  findOrCreateDmChannel,
  getBlockedUserIds,
  getDmRecipientEligibility,
  isDmChannelParticipant,
  checkDmChannelAccess,
  listDmMessages,
  sendDmMessage,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const UID = '00000000-0000-0000-0000-000000000099';
// Lower case, as the database spells every uuid it returns.
const OTHER_UID = '00000000-0000-0000-0000-0000000000bb';
const CHANNEL_ID = '00000000-0000-0000-0000-0000000000CC';

beforeEach(() => {
  vi.resetModules();
  requireMaterializedSession.mockReset();
  listDmChannelsForUser.mockReset();
  findOrCreateDmChannel.mockReset();
  getBlockedUserIds.mockReset();
  isDmChannelParticipant.mockReset();
  // LF-SEC-006 default: participant, no block either direction.
  checkDmChannelAccess.mockReset().mockResolvedValue('ok');
  listDmMessages.mockReset();
  sendDmMessage.mockReset();
  requireMaterializedSession.mockReturnValue({
    ok: true,
    session: { uid: UID, gid: 'g_1', name: 'Caller', exp: 123 },
  });
  getBlockedUserIds.mockResolvedValue(new Set());
  // Default: a live user who shares a community with the caller.
  getDmRecipientEligibility.mockReset().mockResolvedValue({ exists: true, sharesServer: true, existingChannelId: null });
});

describe('GET /api/dm', () => {
  it('returns the DM channel list excluding blocked users', async () => {
    listDmChannelsForUser.mockResolvedValue([
      { id: 'ch-1', otherUserId: OTHER_UID, otherUserDisplayName: 'Bob', otherUserAvatarRef: null, otherUserProfileVisibility: 'server_members', sharesServerWithOtherUser: true, lastMessageAt: new Date() },
      { id: 'ch-2', otherUserId: '00000000-0000-0000-0000-0000000000DD', otherUserDisplayName: 'Blocked', otherUserAvatarRef: null, otherUserProfileVisibility: 'server_members', sharesServerWithOtherUser: true, lastMessageAt: new Date() },
    ]);
    getBlockedUserIds.mockResolvedValue(new Set(['00000000-0000-0000-0000-0000000000DD']));
    const { GET } = await import('../route.js');
    const res = await GET(new Request('https://example.test/api/dm'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { channels: Array<{ otherUserId: string }> };
    expect(json.channels).toHaveLength(1);
    expect(json.channels[0].otherUserId).toBe(OTHER_UID);
  });

  it('security-review FILE-001 / AUTHZ-005: links avatars by URL, per profile visibility', async () => {
    listDmChannelsForUser.mockResolvedValue([
      { id: 'ch-1', otherUserId: OTHER_UID, otherUserDisplayName: 'Bob', otherUserAvatarRef: '0123456789ab', otherUserProfileVisibility: 'server_members', sharesServerWithOtherUser: true, lastMessageAt: new Date() },
      { id: 'ch-3', otherUserId: '00000000-0000-0000-0000-0000000000EE', otherUserDisplayName: 'Hidden', otherUserAvatarRef: 'abcdefabcdef', otherUserProfileVisibility: 'nobody', sharesServerWithOtherUser: true, lastMessageAt: new Date() },
    ]);
    const { GET } = await import('../route.js');
    const res = await GET(new Request('https://example.test/api/dm'), {});
    const text = await res.text();
    expect(text).not.toContain('data:');
    const json = JSON.parse(text) as { channels: Array<{ otherUserDisplayName: string; otherUserAvatarUrl: string | null }> };
    expect(json.channels).toEqual([
      expect.objectContaining({ otherUserDisplayName: 'Bob', otherUserAvatarUrl: `/api/users/${OTHER_UID}/avatar?v=0123456789ab` }),
      expect.objectContaining({ otherUserDisplayName: 'Hidden', otherUserAvatarUrl: null }),
    ]);
    expect(json.channels[0]).not.toHaveProperty('otherUserProfileVisibility');
  });

  it('returns 401 when no session', async () => {
    requireMaterializedSession.mockReturnValue({
      ok: false,
      response: NextResponse.json({ error: 'Auth required' }, { status: 401 }),
    });
    const { GET } = await import('../route.js');
    const res = await GET(new Request('https://example.test/api/dm'), {});
    expect(res.status).toBe(401);
  });
});

describe('POST /api/dm', () => {
  it('creates/reuses a DM channel when neither party is blocked', async () => {
    findOrCreateDmChannel.mockResolvedValue({ id: CHANNEL_ID, userAId: OTHER_UID, userBId: UID, createdBy: UID });
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/dm', {
        method: 'POST',
        body: JSON.stringify({ recipientUserId: OTHER_UID }),
      }),
      {}
    );
    expect(res.status).toBe(200);
    expect(findOrCreateDmChannel).toHaveBeenCalledWith({ __mockDb: true }, UID, OTHER_UID);
  });

  it('returns 403 when the caller has blocked the recipient', async () => {
    getBlockedUserIds.mockImplementation(async (_db, uid) =>
      uid === UID ? new Set([OTHER_UID]) : new Set()
    );
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/dm', {
        method: 'POST',
        body: JSON.stringify({ recipientUserId: OTHER_UID }),
      }),
      {}
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 when the recipient has blocked the caller', async () => {
    getBlockedUserIds.mockImplementation(async (_db, uid) =>
      uid === OTHER_UID ? new Set([UID]) : new Set()
    );
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/dm', {
        method: 'POST',
        body: JSON.stringify({ recipientUserId: OTHER_UID }),
      }),
      {}
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when trying to DM yourself', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/dm', {
        method: 'POST',
        body: JSON.stringify({ recipientUserId: UID }),
      }),
      {}
    );
    expect(res.status).toBe(400);
  });

  // Security review 2026-10 (A8): ids are compared and ordered in lower
  // case — the database's spelling.
  it('an upper-case copy of your own id is still yourself (400), not a DM with yourself', async () => {
    const { POST } = await import('../route.js');
    const OWN_UPPER = '00000000-0000-0000-0000-0000000000AA';
    requireMaterializedSession.mockReturnValue({ ok: true, session: { uid: OWN_UPPER.toLowerCase(), gid: 'g_1', name: 'Caller', exp: 123 } });
    const res = await POST(
      new Request('https://example.test/api/dm', { method: 'POST', body: JSON.stringify({ recipientUserId: OWN_UPPER }) }),
      {}
    );
    expect(res.status).toBe(400);
    expect(findOrCreateDmChannel).not.toHaveBeenCalled();
  });

  it('an upper-case recipient id reaches the eligibility, block and channel lookups in lower case', async () => {
    findOrCreateDmChannel.mockResolvedValue({ id: CHANNEL_ID, userAId: OTHER_UID, userBId: UID, createdBy: UID });
    getBlockedUserIds.mockImplementation(async (_db, uid) => (uid === UID ? new Set([OTHER_UID]) : new Set()));
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/dm', { method: 'POST', body: JSON.stringify({ recipientUserId: OTHER_UID.toUpperCase() }) }),
      {}
    );
    // The caller blocked them: the lower-case block entry matches.
    expect(res.status).toBe(403);
    expect(getDmRecipientEligibility).toHaveBeenCalledWith({ __mockDb: true }, UID, OTHER_UID);
    getBlockedUserIds.mockResolvedValue(new Set());
    expect((await POST(new Request('https://example.test/api/dm', { method: 'POST', body: JSON.stringify({ recipientUserId: OTHER_UID.toUpperCase() }) }), {})).status).toBe(200);
    expect(findOrCreateDmChannel).toHaveBeenCalledWith({ __mockDb: true }, UID, OTHER_UID);
  });
});

// Security review (needs verification #4): any user id used to open a DM,
// and an unknown one 500'd on the FK — an existence oracle. Now: a shared
// community or an existing conversation, else one uniform 404.
describe('POST /api/dm — who may be messaged', () => {
  async function open(recipientUserId = OTHER_UID) {
    const { POST } = await import('../route.js');
    return POST(
      new Request('https://example.test/api/dm', { method: 'POST', body: JSON.stringify({ recipientUserId }) }),
      {}
    );
  }

  it('404 for an unknown user id, without touching the channel table', async () => {
    getDmRecipientEligibility.mockResolvedValue({ exists: false, sharesServer: false, existingChannelId: null });
    const res = await open('00000000-0000-0000-0000-00000000dead');
    expect(res.status).toBe(404);
    expect(findOrCreateDmChannel).not.toHaveBeenCalled();
    expect(getDmRecipientEligibility).toHaveBeenCalledWith({ __mockDb: true }, UID, '00000000-0000-0000-0000-00000000dead');
  });

  it('the same 404 for a real user who shares no community with the caller', async () => {
    getDmRecipientEligibility.mockResolvedValue({ exists: false, sharesServer: false, existingChannelId: null });
    const unknown = await open('00000000-0000-0000-0000-00000000dead');
    getDmRecipientEligibility.mockResolvedValue({ exists: true, sharesServer: false, existingChannelId: null });
    const stranger = await open();
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toEqual(await unknown.json());
    expect(findOrCreateDmChannel).not.toHaveBeenCalled();
  });

  it('an existing conversation can be reopened after the users stop sharing a community', async () => {
    getDmRecipientEligibility.mockResolvedValue({ exists: true, sharesServer: false, existingChannelId: CHANNEL_ID });
    findOrCreateDmChannel.mockResolvedValue({ id: CHANNEL_ID, userAId: OTHER_UID, userBId: UID, createdBy: UID });
    const res = await open();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { channel: { id: string } }).channel.id).toBe(CHANNEL_ID);
  });

  it('a stranger the caller blocked is still a plain 404 (no block oracle for unshared users)', async () => {
    getDmRecipientEligibility.mockResolvedValue({ exists: true, sharesServer: false, existingChannelId: null });
    getBlockedUserIds.mockImplementation(async (_db, uid) => (uid === OTHER_UID ? new Set([UID]) : new Set()));
    const res = await open();
    expect(res.status).toBe(404);
  });

  it('blocks keep their 403 for a user who shares a community', async () => {
    getBlockedUserIds.mockImplementation(async (_db, uid) => (uid === OTHER_UID ? new Set([UID]) : new Set()));
    const res = await open();
    expect(res.status).toBe(403);
    expect(findOrCreateDmChannel).not.toHaveBeenCalled();
  });
});

describe('GET /api/dm/{channelId}/messages', () => {
  function ctx(channelId = CHANNEL_ID) {
    return { params: Promise.resolve({ channelId }) };
  }

  it('returns 404 when the caller is not a participant', async () => {
    isDmChannelParticipant.mockResolvedValue(false);
    const { GET } = await import('../[channelId]/messages/route.js');
    const res = await GET(new Request(`https://example.test/api/dm/${CHANNEL_ID}/messages`), ctx());
    expect(res.status).toBe(404);
  });

  it('returns messages and masks soft-deleted content', async () => {
    isDmChannelParticipant.mockResolvedValue(true);
    listDmMessages.mockResolvedValue([
      { id: 'm1', authorId: UID, content: 'hi', replyToId: null, deletedAt: null, createdAt: new Date('2026-01-01') },
      { id: 'm2', authorId: OTHER_UID, content: 'deleted text', replyToId: null, deletedAt: new Date('2026-01-02'), createdAt: new Date('2026-01-02') },
    ]);
    const { GET } = await import('../[channelId]/messages/route.js');
    const res = await GET(new Request(`https://example.test/api/dm/${CHANNEL_ID}/messages`), ctx());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { messages: Array<{ content: string; deletedAt: string | null }> };
    expect(json.messages).toHaveLength(2);
    expect(json.messages[0].content).toBe('hi');
    expect(json.messages[1].content).toBe(''); // masked
    expect(json.messages[1].deletedAt).not.toBeNull();
  });
});

// Security review 2026-10 (A9): `limit`, `before` and the channel id
// reached Postgres unchecked — junk was a 500 (a non-UUID id threw before
// the route's try block).
describe('GET /api/dm/{channelId}/messages — input', () => {
  function ctx(channelId = CHANNEL_ID) {
    return { params: Promise.resolve({ channelId }) };
  }
  async function get(query = '', channelId = CHANNEL_ID) {
    const { GET } = await import('../[channelId]/messages/route.js');
    return GET(new Request(`https://example.test/api/dm/${channelId}/messages${query}`), ctx(channelId));
  }

  beforeEach(() => {
    isDmChannelParticipant.mockResolvedValue(true);
    listDmMessages.mockResolvedValue([]);
  });

  it('a channel id that is not a UUID is not found — before any query', async () => {
    expect((await get('', 'not-a-uuid')).status).toBe(404);
    expect(isDmChannelParticipant).not.toHaveBeenCalled();
    const { POST } = await import('../[channelId]/messages/route.js');
    const res = await POST(
      new Request('https://example.test/api/dm/not-a-uuid/messages', { method: 'POST', body: JSON.stringify({ content: 'hi' }) }),
      ctx('not-a-uuid')
    );
    expect(res.status).toBe(404);
    expect(checkDmChannelAccess).not.toHaveBeenCalled();
  });

  it('400 for a limit that is not an integer, or a before that is not a date', async () => {
    for (const query of ['?limit=abc', '?limit=12.5', '?limit=', '?before=yesterday', '?before=']) {
      expect((await get(query)).status, query).toBe(400);
    }
    expect(listDmMessages).not.toHaveBeenCalled();
  });

  it('clamps the limit to 1..100 and passes a valid cursor on', async () => {
    await get('?limit=1000');
    expect(listDmMessages).toHaveBeenLastCalledWith({ __mockDb: true }, CHANNEL_ID, { limit: 100 });
    await get('?limit=0');
    expect(listDmMessages).toHaveBeenLastCalledWith({ __mockDb: true }, CHANNEL_ID, { limit: 1 });
    await get('?limit=20&before=2026-10-01T12:00:00.123Z');
    expect(listDmMessages).toHaveBeenLastCalledWith({ __mockDb: true }, CHANNEL_ID, {
      limit: 20,
      before: new Date('2026-10-01T12:00:00.123Z'),
    });
  });

  it('a database failure is a 500 with a body, not a thrown error', async () => {
    isDmChannelParticipant.mockRejectedValue(new Error('db down'));
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load messages' });
  });
});

describe('POST /api/dm/{channelId}/messages', () => {
  function ctx(channelId = CHANNEL_ID) {
    return { params: Promise.resolve({ channelId }) };
  }

  it('sends a message and returns 201 when the caller is a participant', async () => {
    isDmChannelParticipant.mockResolvedValue(true);
    sendDmMessage.mockResolvedValue({ id: 'm3', authorId: UID, content: 'hello', replyToId: null, createdAt: new Date('2026-01-03') });
    const { POST } = await import('../[channelId]/messages/route.js');
    const res = await POST(
      new Request(`https://example.test/api/dm/${CHANNEL_ID}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'hello' }),
      }),
      ctx()
    );
    expect(res.status).toBe(201);
    expect(sendDmMessage).toHaveBeenCalledWith({ __mockDb: true }, CHANNEL_ID, UID, 'hello', null);
  });

  it('returns 404 when not a participant', async () => {
    checkDmChannelAccess.mockResolvedValue('not_participant');
    const { POST } = await import('../[channelId]/messages/route.js');
    const res = await POST(
      new Request(`https://example.test/api/dm/${CHANNEL_ID}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'hello' }),
      }),
      ctx()
    );
    expect(res.status).toBe(404);
  });

  it('LF-SEC-006: 403 when the OTHER side blocked the caller (existing channel)', async () => {
    checkDmChannelAccess.mockResolvedValue('blocked');
    const { POST } = await import('../[channelId]/messages/route.js');
    const res = await POST(
      new Request(`https://example.test/api/dm/${CHANNEL_ID}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'hello' }),
      }),
      ctx()
    );
    expect(res.status).toBe(403);
    expect(sendDmMessage).not.toHaveBeenCalled();
  });

  it('LF-SEC-006: 403 when the CALLER blocked the other side (unblock first)', async () => {
    checkDmChannelAccess.mockResolvedValue('blocked');
    const { POST } = await import('../[channelId]/messages/route.js');
    const res = await POST(
      new Request(`https://example.test/api/dm/${CHANNEL_ID}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'hello' }),
      }),
      ctx()
    );
    expect(res.status).toBe(403);
    expect(sendDmMessage).not.toHaveBeenCalled();
  });

  it('LF-SEC-006: history stays readable after a block (documented policy)', async () => {
    isDmChannelParticipant.mockResolvedValue(true);
    listDmMessages.mockResolvedValue([]);
    const { GET } = await import('../[channelId]/messages/route.js');
    const res = await GET(new Request(`https://example.test/api/dm/${CHANNEL_ID}/messages`), ctx());
    expect(res.status).toBe(200);
    // read-history uses participation only — checkDmChannelAccess is a
    // send/subscribe policy and must not gate the list.
    expect(checkDmChannelAccess).not.toHaveBeenCalledWith(expect.anything(), CHANNEL_ID, UID, 'send');
  });

  it('returns 400 for empty content', async () => {
    const { POST } = await import('../[channelId]/messages/route.js');
    const res = await POST(
      new Request(`https://example.test/api/dm/${CHANNEL_ID}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: '' }),
      }),
      ctx()
    );
    expect(res.status).toBe(400);
  });
});
