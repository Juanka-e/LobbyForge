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
const getDmChannelParticipants = vi.fn();
const publishDmActivity = vi.fn();

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
  getDmChannelParticipants,
}));
vi.mock('@/lib/dm-notify', () => ({ publishDmActivity }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const UID = '00000000-0000-0000-0000-000000000099';
const OTHER_UID = '00000000-0000-0000-0000-0000000000BB';
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

  it('tells the DM lists of both participants, without the message text (docs/PROFILES.md "Live updates")', async () => {
    isDmChannelParticipant.mockResolvedValue(true);
    checkDmChannelAccess.mockResolvedValue('ok');
    sendDmMessage.mockResolvedValue({ id: 'm4', authorId: UID, content: 'secret', replyToId: null, createdAt: new Date('2026-01-03') });
    getDmChannelParticipants.mockResolvedValue({ userAId: UID, userBId: OTHER_UID });
    publishDmActivity.mockClear();
    const { POST } = await import('../[channelId]/messages/route.js');
    const res = await POST(
      new Request(`https://example.test/api/dm/${CHANNEL_ID}/messages`, { method: 'POST', body: JSON.stringify({ content: 'secret' }) }),
      ctx()
    );
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(publishDmActivity).toHaveBeenCalledTimes(1));
    expect(publishDmActivity).toHaveBeenCalledWith({ channelId: CHANNEL_ID, authorId: UID, participantIds: [UID, OTHER_UID] });
    expect(JSON.stringify(publishDmActivity.mock.calls)).not.toContain('secret');
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
