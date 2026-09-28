import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBuiltInBotForServer = vi.fn();
const listBotAccessibleChannels = vi.fn();
const getUserById = vi.fn();
const getServerById = vi.fn();
const getChannelById = vi.fn();
const isChannelOpenToBots = vi.fn();
const createMessage = vi.fn();
const logAction = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  BOT_MESSAGE_CHANNEL_TYPES: ['text', 'announcement'],
  getBuiltInBotForServer,
  listBotAccessibleChannels,
  getUserById,
  getServerById,
  getChannelById,
  isChannelOpenToBots,
  createMessage,
  logAction,
  touchBotLastUsed: vi.fn().mockResolvedValue(undefined),
  listMessagesForChannel: vi.fn(),
  listUserDisplayNames: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
const publishChatMessage = vi.fn();
vi.mock('@/lib/chat-bus', () => ({ publishChatMessage }));

const SERVER = '11111111-1111-4111-8111-111111111111';
const GENERAL = '22222222-2222-4222-8222-222222222222';
const LOUNGE = '66666666-6666-4666-8666-666666666666';
const USER = '33333333-3333-4333-8333-333333333333';
const BOT_ID = '55555555-5555-4555-8555-555555555555';

function welcomeBot(settings: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    id: BOT_ID,
    serverId: SERVER,
    name: 'Greeter',
    type: 'welcome',
    tokenHash: null,
    permissions: ['send_messages'],
    settings,
    enabled: true,
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

async function load() {
  return import('../welcome');
}

beforeEach(() => {
  vi.resetModules();
  for (const fn of [getBuiltInBotForServer, listBotAccessibleChannels, getUserById, getServerById, getChannelById, isChannelOpenToBots, createMessage, logAction, publishChatMessage]) {
    fn.mockReset();
  }
  delete process.env.LOBBYFORGE_DEFAULT_LOCALE;
  logAction.mockResolvedValue(undefined);
  listBotAccessibleChannels.mockResolvedValue([{ id: GENERAL, serverId: SERVER, type: 'text', name: 'general' }]);
  getUserById.mockResolvedValue({ id: USER, displayName: 'Ayşe' });
  getServerById.mockResolvedValue({ id: SERVER, name: 'Oyun Gecesi' });
  getChannelById.mockImplementation(async (_db: unknown, id: string) => ({ id, serverId: SERVER, type: 'text', name: 'c' }));
  isChannelOpenToBots.mockResolvedValue(true);
  createMessage.mockImplementation(async (_db: unknown, row: Record<string, unknown>) => ({
    id: 'm-1',
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

describe('notifyMemberJoined', () => {
  it('does nothing without an enabled welcome bot', async () => {
    const { notifyMemberJoined } = await load();
    getBuiltInBotForServer.mockResolvedValueOnce(null);
    await notifyMemberJoined({ serverId: SERVER, userId: USER });
    getBuiltInBotForServer.mockResolvedValueOnce(welcomeBot({}, { enabled: false }));
    vi.resetModules();
    await (await load()).notifyMemberJoined({ serverId: SERVER, userId: USER });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('greets in the configured channel with the admin template, as the bot', async () => {
    getBuiltInBotForServer.mockResolvedValue(welcomeBot({ channelId: LOUNGE, template: 'Hey {user}, welcome to {server}!' }));
    const { notifyMemberJoined } = await load();
    await notifyMemberJoined({ serverId: SERVER, userId: USER });
    expect(createMessage).toHaveBeenCalledWith(expect.anything(), {
      channelId: LOUNGE,
      userId: null,
      botId: BOT_ID,
      content: 'Hey Ayşe, welcome to Oyun Gecesi!',
      metadata: { bot: { id: BOT_ID, name: 'Greeter', type: 'welcome' } },
    });
    expect(publishChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: SERVER,
        channelId: LOUNGE,
        message: expect.objectContaining({ userId: null, botId: BOT_ID, bot: { id: BOT_ID, name: 'Greeter', type: 'welcome' } }),
      })
    );
  });

  it('falls back to the first open text channel and the default greeting', async () => {
    getBuiltInBotForServer.mockResolvedValue(welcomeBot());
    const { notifyMemberJoined } = await load();
    await notifyMemberJoined({ serverId: SERVER, userId: USER });
    expect(createMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channelId: GENERAL, content: 'Welcome to Oyun Gecesi, Ayşe! Glad you are here.' })
    );
  });

  it('speaks the instance language by default', async () => {
    process.env.LOBBYFORGE_DEFAULT_LOCALE = 'tr';
    getBuiltInBotForServer.mockResolvedValue(welcomeBot());
    const { notifyMemberJoined } = await load();
    await notifyMemberJoined({ serverId: SERVER, userId: USER });
    expect((createMessage.mock.calls[0]![1] as { content: string }).content).toBe(
      'Ayşe, Oyun Gecesi sunucusuna hoş geldin! Seni aramızda görmek güzel.'
    );
  });

  it('cannot be made to ping everyone through a display name', async () => {
    getUserById.mockResolvedValue({ id: USER, displayName: '@everyone' });
    getBuiltInBotForServer.mockResolvedValue(welcomeBot({ template: 'Hi {user}' }));
    const { notifyMemberJoined } = await load();
    await notifyMemberJoined({ serverId: SERVER, userId: USER });
    expect((createMessage.mock.calls[0]![1] as { content: string }).content).toBe('Hi everyone');
  });

  it('does not post into a channel it may not use', async () => {
    isChannelOpenToBots.mockResolvedValue(false);
    getBuiltInBotForServer.mockResolvedValue(welcomeBot({ channelId: LOUNGE }));
    const { notifyMemberJoined } = await load();
    await notifyMemberJoined({ serverId: SERVER, userId: USER });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('caps greetings during a join raid', async () => {
    getBuiltInBotForServer.mockResolvedValue(welcomeBot());
    const { notifyMemberJoined, WELCOME_RATE } = await load();
    for (let i = 0; i < WELCOME_RATE.maxRequests + 3; i += 1) {
      await notifyMemberJoined({ serverId: SERVER, userId: USER });
    }
    expect(createMessage).toHaveBeenCalledTimes(WELCOME_RATE.maxRequests);
  });

  it('never throws, so a join can never fail because of the greeting', async () => {
    getBuiltInBotForServer.mockRejectedValue(new Error('db down'));
    const { notifyMemberJoined } = await load();
    await expect(notifyMemberJoined({ serverId: SERVER, userId: USER })).resolves.toBeUndefined();
  });
});
