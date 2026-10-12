import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBuiltInBotForServer = vi.fn();
const getUserPermissions = vi.fn();
const listUserDisplayNames = vi.fn();
const logAction = vi.fn();
const getChannelById = vi.fn();
const isChannelOpenToBots = vi.fn();
const createMessage = vi.fn();
const touchBotLastUsed = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  // Bot API v2 §1.1: the channel rule lives in @lobbyforge/db; emulate it
  // over this file's channel mocks (no explicit grants → the v1 rule).
  getBotReachableChannel: async (db: unknown, bot: { serverId: string }, id: string) => {
    const channel = await getChannelById(db, id);
    if (!channel || channel.serverId !== bot.serverId || !['text', 'announcement'].includes(channel.type)) return null;
    return (await isChannelOpenToBots(db, id)) ? channel : null;
  },
  listBotReachableChannels: async () => [],
  listBotEventTargets: async () => [],
  listBotChannelAccessForServer: async () => new Map(),
  BOT_MESSAGE_CHANNEL_TYPES: ['text', 'announcement'],
  getBuiltInBotForServer,
  getUserPermissions,
  logAction,
  getChannelById,
  isChannelOpenToBots,
  createMessage,
  touchBotLastUsed,
  listBotAccessibleChannels: vi.fn(),
  listMessagesForChannel: vi.fn(),
  listUserDisplayNames,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
const publishChatMessage = vi.fn();
vi.mock('@/lib/chat-bus', () => ({ publishChatMessage }));

const SERVER = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';
const BOT_ID = '55555555-5555-4555-8555-555555555555';

function moderationBot(settings: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    id: BOT_ID,
    serverId: SERVER,
    name: 'Mod',
    type: 'moderation',
    tokenHash: null,
    tokenIssuedAt: null,
    permissions: ['read_messages', 'moderate_messages', 'send_messages'],
    settings: { blockedWords: ['salak*', 'spam link'], flood: null, repeat: null, ...settings },
    enabled: true,
    createdBy: OWNER,
    createdByName: 'Owner',
    lastUsedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

async function load() {
  return import('../moderation');
}

function input(content: string, extra: Record<string, unknown> = {}) {
  return { serverId: SERVER, channelId: CHANNEL, userId: MEMBER, content, ownerUserId: OWNER, ...extra };
}

beforeEach(() => {
  vi.resetModules();
  for (const fn of [getBuiltInBotForServer, getUserPermissions, listUserDisplayNames, logAction, getChannelById, isChannelOpenToBots, createMessage, touchBotLastUsed, publishChatMessage]) {
    fn.mockReset();
  }
  logAction.mockResolvedValue(undefined);
  touchBotLastUsed.mockResolvedValue(undefined);
  getUserPermissions.mockResolvedValue(['send_messages', 'read_message_history']);
  listUserDisplayNames.mockResolvedValue(new Map([[MEMBER, 'Mallory']]));
  getChannelById.mockResolvedValue({ id: CHANNEL, serverId: SERVER, type: 'text', name: 'general' });
  isChannelOpenToBots.mockResolvedValue(true);
  createMessage.mockImplementation(async (_db: unknown, row: Record<string, unknown>) => ({
    id: 'notice-1',
    channelId: row.channelId,
    userId: null,
    botId: row.botId,
    content: row.content,
    metadata: row.metadata,
    replyToId: null,
    createdAt: new Date(),
    editedAt: null,
    deletedAt: null,
  }));
});

describe('moderateMessage', () => {
  it('allows everything when the server has no moderation bot — without a permission lookup', async () => {
    getBuiltInBotForServer.mockResolvedValue(null);
    const { moderateMessage } = await load();
    expect(await moderateMessage(input('salak'))).toEqual({ action: 'allow' });
    expect(getUserPermissions).not.toHaveBeenCalled();
  });

  it('allows everything while the bot is disabled or lacks moderate_messages', async () => {
    const { moderateMessage } = await load();
    getBuiltInBotForServer.mockResolvedValueOnce(moderationBot({}, { enabled: false }));
    expect((await moderateMessage(input('salak'))).action).toBe('allow');

    vi.resetModules();
    const again = await load();
    getBuiltInBotForServer.mockResolvedValueOnce(moderationBot({}, { permissions: ['send_messages'] }));
    expect((await again.moderateMessage(input('salak'))).action).toBe('allow');
  });

  it('fails open when the bot cannot be loaded', async () => {
    getBuiltInBotForServer.mockRejectedValue(new Error('db down'));
    const { moderateMessage } = await load();
    expect((await moderateMessage(input('salak'))).action).toBe('allow');
  });

  it('blocks a blocked word and writes a transparent audit entry', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot());
    const { moderateMessage, moderationBlockedBody } = await load();
    const verdict = await moderateMessage(input('Sen tam bir SALAKSIN'));
    expect(verdict).toEqual({ action: 'block', rule: 'blocked_word', botId: BOT_ID, botName: 'Mod' });
    expect(logAction).toHaveBeenCalledTimes(1);
    const entry = logAction.mock.calls[0]![1] as Record<string, unknown> & { metadata: Record<string, unknown> };
    expect(entry).toMatchObject({
      serverId: SERVER,
      actorUserId: null,
      action: 'bot.moderation.block',
      targetType: 'user',
      targetId: MEMBER,
    });
    expect(entry.metadata).toMatchObject({
      botId: BOT_ID,
      rule: 'blocked_word',
      detail: 'salak*',
      channelId: CHANNEL,
      excerpt: 'Sen tam bir SALAKSIN',
      kind: 'create',
    });
    expect(entry.metadata.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    if (verdict.action === 'block') {
      expect(moderationBlockedBody(verdict)).toMatchObject({ code: 'blocked_by_moderation', rule: 'blocked_word' });
    }
  });

  it('trims long excerpts', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot());
    const { moderateMessage } = await load();
    await moderateMessage(input(`salak ${'x'.repeat(500)}`));
    const excerpt = (logAction.mock.calls[0]![1] as { metadata: { excerpt: string } }).metadata.excerpt;
    expect(excerpt.length).toBeLessThanOrEqual(121);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('lets the owner and moderators through when staff are exempt', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot());
    const { moderateMessage } = await load();
    expect((await moderateMessage(input('salak', { userId: OWNER }))).action).toBe('allow');
    getUserPermissions.mockResolvedValue(['manage_messages']);
    expect((await moderateMessage(input('salak'))).action).toBe('allow');
    expect(logAction).not.toHaveBeenCalled();
  });

  it('filters staff too when the exemption is off', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot({ exemptStaff: false }));
    const { moderateMessage } = await load();
    expect((await moderateMessage(input('salak', { userId: OWNER }))).action).toBe('block');
  });

  it('blocks links by policy', async () => {
    getBuiltInBotForServer.mockResolvedValue(
      moderationBot({ blockedWords: [], linkPolicy: 'allowlist', allowedDomains: ['lobbyforge.app'] })
    );
    const { moderateMessage } = await load();
    expect((await moderateMessage(input('docs at https://lobbyforge.app/docs'))).action).toBe('allow');
    expect(await moderateMessage(input('free nitro at discord-gift.xyz'))).toMatchObject({ action: 'block', rule: 'link' });
  });

  it('blocks mass mentions', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot({ blockedWords: [], maxMentions: 2 }));
    const { moderateMessage } = await load();
    expect(await moderateMessage(input('@a @b @c'))).toMatchObject({ action: 'block', rule: 'mentions' });
  });

  it('blocks flooding after the limit, per member', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot({ blockedWords: [], flood: { max: 3, windowSeconds: 10 } }));
    const { moderateMessage } = await load();
    for (let i = 0; i < 3; i += 1) {
      expect((await moderateMessage(input(`message ${i}`))).action).toBe('allow');
    }
    expect(await moderateMessage(input('message 4'))).toMatchObject({ action: 'block', rule: 'flood' });
    // Another member has their own budget.
    expect((await moderateMessage(input('hi', { userId: OWNER.replace('4444-8', '4444-9') }))).action).toBe('allow');
  });

  it('blocks the same message sent again and again, case-insensitively', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot({ blockedWords: [], repeat: { max: 2, windowSeconds: 60 } }));
    const { moderateMessage } = await load();
    expect((await moderateMessage(input('BUY NOW'))).action).toBe('allow');
    expect((await moderateMessage(input('buy  now'))).action).toBe('allow');
    expect(await moderateMessage(input('Buy Now'))).toMatchObject({ action: 'block', rule: 'repeat' });
    expect((await moderateMessage(input('something else'))).action).toBe('allow');
  });

  it('runs only the content rules on edits', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot({ flood: { max: 2, windowSeconds: 10 } }));
    const { moderateMessage } = await load();
    for (let i = 0; i < 5; i += 1) {
      expect((await moderateMessage(input(`edit ${i}`, { kind: 'edit' }))).action).toBe('allow');
    }
    expect(await moderateMessage(input('salak', { kind: 'edit' }))).toMatchObject({ action: 'block' });
  });

  it('posts at most one neutral notice per member per channel per minute', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot({ postNotice: true, noticeTemplate: 'Removed a message from {user}.' }));
    const { moderateMessage } = await load();
    await moderateMessage(input('salak'));
    await moderateMessage(input('salak again'));
    await vi.waitFor(() => expect(createMessage).toHaveBeenCalledTimes(1));
    expect(createMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: null,
        botId: BOT_ID,
        content: 'Removed a message from Mallory.',
        metadata: { bot: { id: BOT_ID, name: 'Mod', type: 'moderation' } },
      })
    );
    expect(publishChatMessage).toHaveBeenCalledTimes(1);
    // security-review FILE-001: the notice reads the member's name only,
    // never a full user row (which carries the image data URLs).
    expect(listUserDisplayNames).toHaveBeenCalledWith(expect.anything(), [MEMBER]);
  });

  it('uses the translated default notice when the admin wrote none', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot({ postNotice: true }));
    const { moderateMessage } = await load();
    await moderateMessage(input('salak'));
    await vi.waitFor(() => expect(createMessage).toHaveBeenCalled());
    expect((createMessage.mock.calls[0]![1] as { content: string }).content).toBe(
      'A message from Mallory was blocked by the moderation filter.'
    );
  });

  it('stores the default notice with its catalogue key, so each member reads it in their own language', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot({ postNotice: true }));
    const { moderateMessage } = await load();
    await moderateMessage(input('salak'));
    await vi.waitFor(() => expect(createMessage).toHaveBeenCalled());
    expect((createMessage.mock.calls[0]![1] as { metadata: unknown }).metadata).toEqual({
      i18n: { key: 'bots.moderation.defaultNotice', params: { user: 'Mallory' } },
      bot: { id: BOT_ID, name: 'Mod', type: 'moderation' },
    });
  });

  it('a stored notice equal to a shipped default in any language counts as the default', async () => {
    getBuiltInBotForServer.mockResolvedValue(
      moderationBot({ postNotice: true, noticeTemplate: '{user} kullanıcısının bir mesajı moderasyon filtresine takıldı.' })
    );
    const { moderateMessage } = await load();
    await moderateMessage(input('salak'));
    await vi.waitFor(() => expect(createMessage).toHaveBeenCalled());
    const row = createMessage.mock.calls[0]![1] as { content: string; metadata: Record<string, unknown> };
    expect(row.content).toBe('A message from Mallory was blocked by the moderation filter.');
    expect(row.metadata.i18n).toEqual({ key: 'bots.moderation.defaultNotice', params: { user: 'Mallory' } });
  });
});

describe('moderateAppMessage — a plugin’s chat.post', () => {
  const app = { serverId: SERVER, channelId: CHANNEL, pluginId: 'sandbox-buzzer', pluginName: 'Buzzer', sessionId: 'sess-1' };

  it('blocks a blocked word or a refused link, audited as a block by the plugin — no notice, no staff exemption', async () => {
    getBuiltInBotForServer.mockResolvedValue(
      moderationBot({ postNotice: true, exemptStaff: true, linkPolicy: 'allowlist', allowedDomains: ['lobbyforge.app'] })
    );
    const { moderateAppMessage } = await load();
    expect(await moderateAppMessage({ ...app, content: 'Team SALAKSIN won' })).toEqual({
      action: 'block',
      rule: 'blocked_word',
      botId: BOT_ID,
      botName: 'Mod',
    });
    expect((await moderateAppMessage({ ...app, content: 'prizes at https://evil.example/x' })).action).toBe('block');
    expect((await moderateAppMessage({ ...app, content: 'docs: https://lobbyforge.app/help' })).action).toBe('allow');
    expect(logAction).toHaveBeenCalledTimes(2);
    const entry = logAction.mock.calls[0]![1] as Record<string, unknown> & { metadata: Record<string, unknown> };
    expect(entry).toMatchObject({ actorUserId: null, action: 'bot.moderation.block', targetType: 'plugin', targetId: 'sandbox-buzzer' });
    expect(entry.metadata).toMatchObject({
      rule: 'blocked_word',
      channelId: CHANNEL,
      kind: 'app',
      pluginName: 'Buzzer',
      sessionId: 'sess-1',
      excerpt: 'Team SALAKSIN won',
    });
    expect(entry.metadata.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    // An app is not a member: no permission lookup, no notice in the channel.
    expect(getUserPermissions).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('a role-gated channel: the audit entry leaves its words out', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot());
    isChannelOpenToBots.mockResolvedValue(false);
    const { moderateAppMessage } = await load();
    expect((await moderateAppMessage({ ...app, content: 'salak' })).action).toBe('block');
    const entry = logAction.mock.calls[0]![1] as { metadata: Record<string, unknown> };
    expect(entry.metadata.excerpt).toBeNull();
  });

  it('the mention rule does not apply (an app’s mentions are inert), and nothing is blocked without the bot', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot({ blockedWords: [], maxMentions: 1 }));
    const { moderateAppMessage } = await load();
    expect((await moderateAppMessage({ ...app, content: '@ayse @mert @deniz tied!' })).action).toBe('allow');

    vi.resetModules();
    getBuiltInBotForServer.mockResolvedValue(null);
    const again = await load();
    expect((await again.moderateAppMessage({ ...app, content: 'salak' })).action).toBe('allow');
    expect(logAction).not.toHaveBeenCalled();
  });
});

describe('moderateWebhookMessage — the notice', () => {
  const webhook = { id: '77777777-7777-4777-8777-777777777777', name: 'CI' };

  it('names the webhook; the default notice carries its catalogue key, an admin text does not', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot({ postNotice: true }));
    const { moderateWebhookMessage } = await load();
    const verdict = await moderateWebhookMessage({ serverId: SERVER, channelId: CHANNEL, webhook, content: 'salak' });
    expect(verdict).toMatchObject({ action: 'block' });
    await vi.waitFor(() => expect(createMessage).toHaveBeenCalled());
    expect(createMessage.mock.calls[0]![1]).toMatchObject({
      content: 'A message from CI was blocked by the moderation filter.',
      metadata: { i18n: { key: 'bots.moderation.defaultNotice', params: { user: 'CI' } } },
    });

    createMessage.mockClear();
    vi.resetModules();
    getBuiltInBotForServer.mockResolvedValue(moderationBot({ postNotice: true, noticeTemplate: 'Removed: {user}' }));
    const again = await load();
    await again.moderateWebhookMessage({ serverId: SERVER, channelId: CHANNEL, webhook, content: 'salak' });
    await vi.waitFor(() => expect(createMessage).toHaveBeenCalled());
    expect(createMessage.mock.calls[0]![1]).toMatchObject({ content: 'Removed: CI', metadata: { bot: { id: BOT_ID } } });
    expect((createMessage.mock.calls[0]![1] as { metadata: Record<string, unknown> }).metadata).not.toHaveProperty('i18n');
  });
});
