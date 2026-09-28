import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * Bots milestone: the Moderation Bot inside the channel messages route
 * (POST and content edits), and bot-authored messages in the list — the
 * real route, the real moderation module and the real in-memory rate
 * limiter; only the database and the realtime bus are mocked.
 */

const getServerById = vi.fn();
const isServerMember = vi.fn();
const getChannelById = vi.fn();
const getUserPermissions = vi.fn();
const canMemberAccessChannel = vi.fn();
const getActiveMemberTimeout = vi.fn();
const createMessage = vi.fn();
const listMessagesForChannel = vi.fn();
const getBlockedUserIds = vi.fn();
const getMessageById = vi.fn();
const updateMessage = vi.fn();
const logAction = vi.fn();
const getBuiltInBotForServer = vi.fn();
const getUserById = vi.fn();
const isChannelOpenToBots = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  BOT_MESSAGE_CHANNEL_TYPES: ['text', 'announcement'],
  getServerById,
  isServerMember,
  getChannelById,
  getUserPermissions,
  canMemberAccessChannel,
  getActiveMemberTimeout,
  createMessage,
  listMessagesForChannel,
  getBlockedUserIds,
  getMessageById,
  updateMessage,
  softDeleteMessage: vi.fn(),
  logAction,
  getBuiltInBotForServer,
  getUserById,
  isChannelOpenToBots,
  touchBotLastUsed: vi.fn().mockResolvedValue(undefined),
  listBotAccessibleChannels: vi.fn(),
  listUserDisplayNames: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security-headers')>('@/lib/security-headers');
  return { ...actual, withApiSecurity: (handler: unknown) => handler };
});
const publishChatMessage = vi.fn();
vi.mock('@/lib/chat-bus', () => ({ publishChatMessage }));

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const OWNER = '44444444-4444-4444-8444-444444444444';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const OUTSIDER = '66666666-6666-4666-8666-666666666666';
const BOT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Tester' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function moderationBot(settings: Record<string, unknown> = {}) {
  return {
    id: BOT_ID,
    serverId: SERVER,
    name: 'Mod',
    type: 'moderation',
    tokenHash: null,
    permissions: ['read_messages', 'moderate_messages', 'send_messages'],
    settings: { blockedWords: ['salak*'], flood: null, repeat: null, ...settings },
    enabled: true,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };
}

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    channelId: CHANNEL,
    userId: MEMBER,
    botId: null,
    content: 'hello',
    metadata: {},
    replyToId: null,
    createdAt: new Date('2026-09-28T10:00:00Z'),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

const ctx = { params: Promise.resolve({ id: SERVER, channelId: CHANNEL }) };
const itemCtx = { params: Promise.resolve({ id: SERVER, channelId: CHANNEL, messageId: 'msg-1' }) };

function post(uid: string, content: string) {
  return new Request(`https://chat.example.test/api/servers/${SERVER}/channels/${CHANNEL}/messages`, {
    method: 'POST',
    headers: { cookie: cookie(uid), 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

beforeEach(() => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of [getServerById, isServerMember, getChannelById, getUserPermissions, canMemberAccessChannel, getActiveMemberTimeout, createMessage, listMessagesForChannel, getBlockedUserIds, getMessageById, updateMessage, logAction, getBuiltInBotForServer, getUserById, isChannelOpenToBots, publishChatMessage]) {
    fn.mockReset();
  }
  getServerById.mockResolvedValue({ id: SERVER, name: 'Lobby', ownerUserId: OWNER });
  isServerMember.mockImplementation(async (_db: unknown, uid: string) => uid === MEMBER || uid === OWNER);
  getChannelById.mockResolvedValue({ id: CHANNEL, serverId: SERVER, type: 'text', name: 'general' });
  getUserPermissions.mockImplementation(async (_db: unknown, uid: string) =>
    uid === OWNER ? ['administrator'] : uid === MEMBER ? ['send_messages', 'read_message_history'] : []
  );
  canMemberAccessChannel.mockResolvedValue(true);
  getActiveMemberTimeout.mockResolvedValue(null);
  getBlockedUserIds.mockResolvedValue(new Set());
  logAction.mockResolvedValue(undefined);
  getUserById.mockResolvedValue({ id: MEMBER, displayName: 'Mallory' });
  isChannelOpenToBots.mockResolvedValue(true);
  getBuiltInBotForServer.mockResolvedValue(moderationBot());
  createMessage.mockImplementation(async (_db: unknown, row: Record<string, unknown>) =>
    messageRow({ id: 'msg-new', ...row })
  );
});

function blockAudits() {
  return logAction.mock.calls.map((c) => c[1] as { action: string }).filter((e) => e.action === 'bot.moderation.block');
}

describe('Moderation Bot on POST .../messages', () => {
  it('blocks a member’s message with a translatable reason and an audit entry', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(post(MEMBER, 'sen bir SALAKSIN'), ctx);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: 'blocked_by_moderation',
      rule: 'blocked_word',
      bot: { id: BOT_ID, name: 'Mod' },
    });
    expect(createMessage).not.toHaveBeenCalled();
    expect(publishChatMessage).not.toHaveBeenCalled();
    expect(blockAudits()).toHaveLength(1);
  });

  it('lets a clean message through', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(post(MEMBER, 'merhaba herkese'), ctx);
    expect(res.status).toBe(201);
    expect(createMessage).toHaveBeenCalled();
  });

  it('exempts the owner by default', async () => {
    const { POST } = await import('../route.js');
    expect((await POST(post(OWNER, 'salak'), ctx)).status).toBe(201);
  });

  it('runs after the membership check — an outsider gets 403, not a moderation verdict', async () => {
    const { POST } = await import('../route.js');
    expect((await POST(post(OUTSIDER, 'salak'), ctx)).status).toBe(403);
    expect(getBuiltInBotForServer).not.toHaveBeenCalled();
  });

  it('stops a flood across requests', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot({ blockedWords: [], flood: { max: 3, windowSeconds: 10 } }));
    const { POST } = await import('../route.js');
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await POST(post(MEMBER, `line ${i}`), ctx)).status);
    expect(statuses).toEqual([201, 201, 201, 422]);
  });

  it('allows everything when the server has no moderation bot', async () => {
    getBuiltInBotForServer.mockResolvedValue(null);
    const { POST } = await import('../route.js');
    expect((await POST(post(MEMBER, 'salak'), ctx)).status).toBe(201);
  });
});

describe('Moderation Bot on PATCH .../messages/{id}', () => {
  it('blocks an edit that adds a blocked word', async () => {
    getMessageById.mockResolvedValue(messageRow());
    const { PATCH } = await import('../[messageId]/route.js');
    const res = await PATCH(
      new Request('https://chat.example.test/x', {
        method: 'PATCH',
        headers: { cookie: cookie(MEMBER), 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'actually, salak' }),
      }),
      itemCtx
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'blocked_by_moderation', rule: 'blocked_word' });
    expect(updateMessage).not.toHaveBeenCalled();
  });
});

describe('bot messages in GET .../messages', () => {
  it('names the bot and never passes it off as a user', async () => {
    listMessagesForChannel.mockResolvedValue([
      messageRow({ id: 'm2', userId: null, botId: BOT_ID, content: 'Welcome!', metadata: { bot: { id: BOT_ID, name: 'Greeter', type: 'welcome' } } }),
      messageRow({ id: 'm1' }),
    ]);
    const { GET } = await import('../route.js');
    const res = await GET(
      new Request(`https://chat.example.test/api/servers/${SERVER}/channels/${CHANNEL}/messages`, {
        headers: { cookie: cookie(MEMBER) },
      }),
      ctx
    );
    expect(res.status).toBe(200);
    const { messages } = (await res.json()) as { messages: Array<Record<string, unknown>> };
    expect(messages[0]).toMatchObject({ userId: null, botId: BOT_ID, bot: { id: BOT_ID, name: 'Greeter', type: 'welcome' } });
    expect(messages[1]).toMatchObject({ userId: MEMBER, botId: null, bot: null });
  });
});
