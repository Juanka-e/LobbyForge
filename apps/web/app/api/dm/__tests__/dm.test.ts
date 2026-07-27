import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireMaterializedSession = vi.fn();
const listDmChannelsForUser = vi.fn();
const findOrCreateDmChannel = vi.fn();
const getBlockedUserIds = vi.fn();
const isDmChannelParticipant = vi.fn();
const listDmMessages = vi.fn();
const sendDmMessage = vi.fn();

vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
vi.mock('@lobbyforge/db', () => ({
  listDmChannelsForUser,
  findOrCreateDmChannel,
  getBlockedUserIds,
  isDmChannelParticipant,
  listDmMessages,
  sendDmMessage,
}));
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
  listDmMessages.mockReset();
  sendDmMessage.mockReset();
  requireMaterializedSession.mockReturnValue({
    ok: true,
    session: { uid: UID, gid: 'g_1', name: 'Caller', exp: 123 },
  });
  getBlockedUserIds.mockResolvedValue(new Set());
});

describe('GET /api/dm', () => {
  it('returns the DM channel list excluding blocked users', async () => {
    listDmChannelsForUser.mockResolvedValue([
      { id: 'ch-1', otherUserId: OTHER_UID, otherUserDisplayName: 'Bob', otherUserAvatarUrl: null, lastMessageAt: new Date() },
      { id: 'ch-2', otherUserId: '00000000-0000-0000-0000-0000000000DD', otherUserDisplayName: 'Blocked', otherUserAvatarUrl: null, lastMessageAt: new Date() },
    ]);
    getBlockedUserIds.mockResolvedValue(new Set(['00000000-0000-0000-0000-0000000000DD']));
    const { GET } = await import('../route.js');
    const res = await GET(new Request('https://example.test/api/dm'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { channels: Array<{ otherUserId: string }> };
    expect(json.channels).toHaveLength(1);
    expect(json.channels[0].otherUserId).toBe(OTHER_UID);
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

  it('returns 404 when not a participant', async () => {
    isDmChannelParticipant.mockResolvedValue(false);
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
