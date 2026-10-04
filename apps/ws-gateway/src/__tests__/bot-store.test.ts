/**
 * Bot API v2 §1.1 + §4.2: the channel set a bot hears, and how a bus
 * message becomes a feed message (loaded from the database, never taken
 * from the publisher's payload).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getActiveBotById: vi.fn(),
  getBotReachableChannel: vi.fn(),
  getMessageById: vi.fn(),
  listBotAccessibleChannels: vi.fn(),
  listBotReachableChannels: vi.fn(),
  listUserDisplayNames: vi.fn(),
}));
vi.mock('@lobbyforge/db', () => dbMocks);

import { __resetBotStore, botReachesChannel, listBotFeedChannels, loadBot, loadFeedMessage } from '../bot-store.js';

const SERVER = '10000000-0000-4000-8000-000000000001';
const BOT = { id: '20000000-0000-4000-8000-000000000001', serverId: SERVER };
const CH1 = '30000000-0000-4000-8000-000000000001';
const CH2 = '30000000-0000-4000-8000-000000000002';
const MSG = '40000000-0000-4000-8000-000000000001';
const USER = '50000000-0000-4000-8000-000000000001';

const db = { __db: true };

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  __resetBotStore();
});

describe('listBotFeedChannels (§1.1)', () => {
  it('uses the shared rule from @lobbyforge/db, scoped to this bot and its server', async () => {
    dbMocks.listBotReachableChannels.mockResolvedValue([
      { id: CH1, name: 'general', type: 'text', serverId: SERVER, position: 0, topic: 'hi' },
      { id: CH2, name: 'news', type: 'announcement', serverId: SERVER, position: 1, topic: null },
    ]);
    await expect(listBotFeedChannels(db, BOT)).resolves.toEqual([
      { id: CH1, name: 'general' },
      { id: CH2, name: 'news' },
    ]);
    expect(dbMocks.listBotReachableChannels).toHaveBeenCalledWith(db, { id: BOT.id, serverId: SERVER });
    expect(dbMocks.listBotAccessibleChannels).not.toHaveBeenCalled();
  });

  it('caps the list', async () => {
    dbMocks.listBotReachableChannels.mockResolvedValue([
      { id: CH1, name: 'a' },
      { id: CH2, name: 'b' },
    ]);
    await expect(listBotFeedChannels(db, BOT, 1)).resolves.toEqual([{ id: CH1, name: 'a' }]);
  });

  it('a bot in selected mode whose last channel is gone hears NOTHING — never the v1 rule', async () => {
    // The shared rule answers [] for "selected, no grants"; the feed must not
    // treat an empty answer as "fall back to every open channel".
    dbMocks.listBotReachableChannels.mockResolvedValue([]);
    dbMocks.listBotAccessibleChannels.mockResolvedValue([{ id: CH1, name: 'general' }]);
    await expect(listBotFeedChannels(db, BOT)).resolves.toEqual([]);
    expect(dbMocks.listBotAccessibleChannels).not.toHaveBeenCalled();
  });

  it('a missing mode column (migration not run yet) also means the v1 rule — the only mode there is', async () => {
    dbMocks.listBotReachableChannels.mockRejectedValue(
      Object.assign(new Error('column "channel_access_mode" does not exist'), { code: '42703' })
    );
    dbMocks.listBotAccessibleChannels.mockResolvedValue([{ id: CH1, name: 'general' }]);
    await expect(listBotFeedChannels(db, BOT)).resolves.toEqual([{ id: CH1, name: 'general' }]);
  });

  it('one channel: the same shared rule', async () => {
    dbMocks.getBotReachableChannel.mockResolvedValueOnce({ id: CH1 }).mockResolvedValueOnce(null);
    await expect(botReachesChannel(db, BOT, CH1)).resolves.toBe(true);
    await expect(botReachesChannel(db, BOT, CH2)).resolves.toBe(false);
    expect(dbMocks.getBotReachableChannel).toHaveBeenCalledWith(db, { id: BOT.id, serverId: SERVER }, CH1);
  });

  it('a missing bot_channel_access table (migration not run yet) means no grants: the v1 rule', async () => {
    dbMocks.listBotReachableChannels.mockRejectedValue(
      Object.assign(new Error('Failed query'), { cause: { code: '42P01' } })
    );
    dbMocks.listBotAccessibleChannels.mockResolvedValue([{ id: CH1, name: 'general' }]);
    await expect(listBotFeedChannels(db, BOT)).resolves.toEqual([{ id: CH1, name: 'general' }]);
    expect(dbMocks.listBotAccessibleChannels).toHaveBeenCalledWith(db, SERVER);
  });

  it('any other database error propagates (the caller fails closed)', async () => {
    dbMocks.listBotReachableChannels.mockRejectedValue(
      Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
    );
    await expect(listBotFeedChannels(db, BOT)).rejects.toThrow('connection refused');
    expect(dbMocks.listBotAccessibleChannels).not.toHaveBeenCalled();
  });
});

describe('loadBot', () => {
  it('maps the row and returns null when the bot or its server is gone', async () => {
    dbMocks.getActiveBotById.mockResolvedValueOnce({
      id: BOT.id,
      serverId: SERVER,
      name: 'Roller',
      type: 'custom',
      tokenHash: 'sha256$x',
      permissions: ['receive_events'],
      enabled: true,
      settings: {},
    });
    await expect(loadBot({}, BOT.id)).resolves.toEqual({
      id: BOT.id,
      serverId: SERVER,
      name: 'Roller',
      type: 'custom',
      tokenHash: 'sha256$x',
      permissions: ['receive_events'],
      enabled: true,
    });
    dbMocks.getActiveBotById.mockResolvedValueOnce(null);
    await expect(loadBot({}, BOT.id)).resolves.toBeNull();
  });
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: MSG,
    channelId: CH1,
    userId: USER,
    botId: null,
    content: 'hello',
    metadata: {},
    replyToId: null,
    createdAt: new Date('2026-10-01T10:00:00Z'),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('loadFeedMessage (§4.2 message shape)', () => {
  it('a member message carries the author display name', async () => {
    dbMocks.getMessageById.mockResolvedValue(row());
    dbMocks.listUserDisplayNames.mockResolvedValue(new Map([[USER, 'Ayşe']]));
    await expect(loadFeedMessage({}, MSG, CH1, 'v1')).resolves.toEqual({
      botId: null,
      message: {
        id: MSG,
        channelId: CH1,
        content: 'hello',
        author: { id: USER, displayName: 'Ayşe' },
        createdAt: '2026-10-01T10:00:00.000Z',
        editedAt: null,
        replyToId: null,
      },
    });
  });

  it('marks bot and webhook authors, and a deleted user as unknown', async () => {
    dbMocks.getMessageById.mockResolvedValueOnce(
      row({ userId: null, botId: 'bot-9', metadata: { bot: { id: 'bot-9', name: 'Welcome', type: 'welcome' } } })
    );
    expect((await loadFeedMessage({}, MSG, CH1, 'a'))!).toMatchObject({
      botId: 'bot-9',
      message: { author: { id: 'bot-9', displayName: 'Welcome', bot: true } },
    });
    dbMocks.getMessageById.mockResolvedValueOnce(
      row({ userId: null, metadata: { webhook: { id: 'wh-1', name: 'CI', username: 'Deploys' } } })
    );
    expect((await loadFeedMessage({}, MSG, CH1, 'b'))!.message.author).toEqual({
      id: 'wh-1',
      displayName: 'Deploys',
      webhook: true,
    });
    dbMocks.getMessageById.mockResolvedValueOnce(row({ userId: null }));
    expect((await loadFeedMessage({}, MSG, CH1, 'c'))!.message.author).toEqual({ id: null, displayName: null });
  });

  it('refuses a message from another channel than the topic, or a deleted one', async () => {
    dbMocks.getMessageById.mockResolvedValueOnce(row({ channelId: CH2 }));
    await expect(loadFeedMessage({}, MSG, CH1, 'x')).resolves.toBeNull();
    dbMocks.getMessageById.mockResolvedValueOnce(null);
    await expect(loadFeedMessage({}, MSG, CH1, 'y')).resolves.toBeNull();
  });

  it('shares one load per (message, bus event) between connections, but not across edits', async () => {
    dbMocks.getMessageById.mockResolvedValue(row());
    dbMocks.listUserDisplayNames.mockResolvedValue(new Map([[USER, 'Ayşe']]));
    await Promise.all([loadFeedMessage({}, MSG, CH1, 'create:t1'), loadFeedMessage({}, MSG, CH1, 'create:t1')]);
    expect(dbMocks.getMessageById).toHaveBeenCalledTimes(1);
    await loadFeedMessage({}, MSG, CH1, 'update:t2');
    expect(dbMocks.getMessageById).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed load', async () => {
    dbMocks.getMessageById.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(row());
    dbMocks.listUserDisplayNames.mockResolvedValue(new Map());
    await expect(loadFeedMessage({}, MSG, CH1, 'k')).rejects.toThrow('db down');
    await expect(loadFeedMessage({}, MSG, CH1, 'k')).resolves.not.toBeNull();
  });
});
