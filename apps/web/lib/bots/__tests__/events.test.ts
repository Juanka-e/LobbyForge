import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Bot event fan-out (BOT_API_V2 §4): who hears a message / member event,
 * the bounded per-server cache (no query per bot per message), the Redis
 * channel names the gateway consumes, and the delivery-time re-check that
 * keeps a stale cache from ever leaking a message.
 */

const listBotEventTargets = vi.fn();
const listBotChannelAccessForServer = vi.fn();
const isChannelOpenToBots = vi.fn();
const getChannelById = vi.fn();
const getUserById = vi.fn();
const listUserDisplayNames = vi.fn();
const getBotReachableChannel = vi.fn();
const listBotReachableChannels = vi.fn();
vi.mock('@lobbyforge/db', () => ({
  listBotEventTargets,
  listBotChannelAccessForServer,
  isChannelOpenToBots,
  getChannelById,
  getUserById,
  listUserDisplayNames,
  getBotReachableChannel,
  listBotReachableChannels,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
const enqueueDelivery = vi.fn();
vi.mock('../event-delivery', () => ({ enqueueDelivery }));
const publish = vi.fn();
vi.mock('@/lib/redis', () => ({ redis: { publish } }));
const publishAccessInvalidation = vi.fn();
vi.mock('@/lib/access-invalidation', () => ({ publishAccessInvalidation }));

const SERVER = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const GATED = '88888888-8888-4888-8888-888888888888';
const USER = '33333333-3333-4333-8333-333333333333';

function target(botId: string, overrides: Record<string, unknown> = {}) {
  return {
    botId,
    botName: `Bot ${botId}`,
    permissions: ['read_messages', 'read_members', 'receive_events', 'slash_commands'],
    channelAccessMode: 'all',
    endpoint: { url: `https://${botId}.example.com`, events: ['message_create', 'message_update', 'message_delete', 'member_join', 'member_leave'], enabled: true },
    ...overrides,
  };
}

const message = { id: 'm1', content: 'hello', createdAt: '2026-10-03T12:00:00.000Z', userId: USER };

async function load() {
  return import('../events');
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'test');
  for (const fn of [listBotEventTargets, listBotChannelAccessForServer, isChannelOpenToBots, getChannelById, getUserById, listUserDisplayNames, getBotReachableChannel, listBotReachableChannels, enqueueDelivery, publish, publishAccessInvalidation]) {
    fn.mockReset();
  }
  listBotEventTargets.mockResolvedValue([]);
  listBotChannelAccessForServer.mockResolvedValue(new Map());
  isChannelOpenToBots.mockImplementation(async (_db: unknown, id: string) => id !== GATED);
  listUserDisplayNames.mockResolvedValue(new Map([[USER, 'Ayşe']]));
  getUserById.mockResolvedValue({ id: USER, displayName: 'Ayşe' });
  publish.mockResolvedValue(1);
});

describe('message events → outgoing endpoints', () => {
  it('queues one signed delivery per subscribed bot that may read the channel', async () => {
    listBotEventTargets.mockResolvedValue([
      target('a'),
      target('no-read', { permissions: ['receive_events'] }),
      target('no-stream-perm', { permissions: ['read_messages'] }),
      target('off', { endpoint: { url: 'https://off.test', events: ['message_create'], enabled: false } }),
      target('other-events', { endpoint: { url: 'https://o.test', events: ['member_join'], enabled: true } }),
      target('no-endpoint', { endpoint: null }),
    ]);
    const { __emitMessageEventNow } = await load();
    const count = await __emitMessageEventNow({ serverId: SERVER, channel: { id: CHANNEL, type: 'text' }, event: 'message_create', message });
    expect(count).toBe(1);
    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
    const job = enqueueDelivery.mock.calls[0]![0];
    expect(job).toMatchObject({
      botId: 'a',
      serverId: SERVER,
      event: 'message_create',
      data: {
        event: 'message_create',
        message: { id: 'm1', channelId: CHANNEL, content: 'hello', author: { id: USER, displayName: 'Ayşe' }, createdAt: message.createdAt },
      },
    });
  });

  it('never tells a bot about its own message', async () => {
    listBotEventTargets.mockResolvedValue([target('a'), target('b')]);
    const { __emitMessageEventNow } = await load();
    await __emitMessageEventNow({
      serverId: SERVER,
      channel: { id: CHANNEL, type: 'text' },
      event: 'message_create',
      message: { id: 'm2', content: 'hi', bot: { id: 'a', name: 'Bot a' } },
    });
    expect(enqueueDelivery.mock.calls.map((c) => c[0].botId)).toEqual(['b']);
    expect(enqueueDelivery.mock.calls[0]![0].data.message.author).toEqual({ id: 'a', displayName: 'Bot a', bot: true });
  });

  it('honours channel access: v1-rule bots skip a role-gated channel, a bot granted it hears it', async () => {
    listBotEventTargets.mockResolvedValue([target('open'), target('granted', { channelAccessMode: 'selected' })]);
    listBotChannelAccessForServer.mockResolvedValue(new Map([['granted', [GATED]]]));
    const { __emitMessageEventNow } = await load();
    await __emitMessageEventNow({ serverId: SERVER, channel: { id: GATED, type: 'text' }, event: 'message_create', message });
    expect(enqueueDelivery.mock.calls.map((c) => c[0].botId)).toEqual(['granted']);
    enqueueDelivery.mockClear();
    await __emitMessageEventNow({ serverId: SERVER, channel: { id: CHANNEL, type: 'text' }, event: 'message_create', message });
    // `granted` has explicit grants that do not include CHANNEL.
    expect(enqueueDelivery.mock.calls.map((c) => c[0].botId)).toEqual(['open']);
  });

  it('a selected-mode bot whose last channel was deleted hears NOTHING — not every open channel', async () => {
    // No grant rows left (they cascaded with the channel): the stored mode decides.
    listBotEventTargets.mockResolvedValue([target('emptied', { channelAccessMode: 'selected' }), target('open')]);
    listBotChannelAccessForServer.mockResolvedValue(new Map());
    const { __emitMessageEventNow } = await load();
    await __emitMessageEventNow({ serverId: SERVER, channel: { id: CHANNEL, type: 'text' }, event: 'message_create', message });
    expect(enqueueDelivery.mock.calls.map((c) => c[0].botId)).toEqual(['open']);
  });

  it('an unknown mode (or a target row without one) is treated as selected, never as "all"', async () => {
    listBotEventTargets.mockResolvedValue([target('weird', { channelAccessMode: 'everything' }), target('missing', { channelAccessMode: undefined })]);
    const { __emitMessageEventNow } = await load();
    expect(await __emitMessageEventNow({ serverId: SERVER, channel: { id: CHANNEL, type: 'text' }, event: 'message_create', message })).toBe(0);
    expect(isChannelOpenToBots).not.toHaveBeenCalled();
  });

  it('is bounded: targets load once per server (cached), the gate is read only when a v1-rule bot listens', async () => {
    listBotEventTargets.mockResolvedValue([target('granted', { channelAccessMode: 'selected' })]);
    listBotChannelAccessForServer.mockResolvedValue(new Map([['granted', [CHANNEL]]]));
    const { __emitMessageEventNow, invalidateBotEventTargets } = await load();
    for (let i = 0; i < 5; i++) {
      await __emitMessageEventNow({ serverId: SERVER, channel: { id: CHANNEL, type: 'text' }, event: 'message_create', message });
    }
    expect(listBotEventTargets).toHaveBeenCalledTimes(1);
    expect(listBotChannelAccessForServer).toHaveBeenCalledTimes(1);
    expect(isChannelOpenToBots).not.toHaveBeenCalled();
    invalidateBotEventTargets(SERVER);
    await __emitMessageEventNow({ serverId: SERVER, channel: { id: CHANNEL, type: 'text' }, event: 'message_create', message });
    expect(listBotEventTargets).toHaveBeenCalledTimes(2);
  });

  it('a server without custom bots costs one query and no grants lookup', async () => {
    const { __emitMessageEventNow } = await load();
    expect(await __emitMessageEventNow({ serverId: SERVER, channel: { id: CHANNEL, type: 'text' }, event: 'message_create', message })).toBe(0);
    expect(listBotChannelAccessForServer).not.toHaveBeenCalled();
  });

  it('ignores channels bots never use, and looks the type up only when someone listens', async () => {
    listBotEventTargets.mockResolvedValue([target('a')]);
    const { __emitMessageEventNow } = await load();
    expect(await __emitMessageEventNow({ serverId: SERVER, channel: { id: CHANNEL, type: 'voice' }, event: 'message_create', message })).toBe(0);
    expect(listBotEventTargets).not.toHaveBeenCalled();
    getChannelById.mockResolvedValue({ id: CHANNEL, serverId: SERVER, type: 'voice' });
    expect(await __emitMessageEventNow({ serverId: SERVER, channel: { id: CHANNEL }, event: 'message_update', message })).toBe(0);
    getChannelById.mockResolvedValue({ id: CHANNEL, serverId: SERVER, type: 'text' });
    expect(await __emitMessageEventNow({ serverId: SERVER, channel: { id: CHANNEL }, event: 'message_update', message })).toBe(1);
  });

  it('a delete carries only the id and channel', async () => {
    listBotEventTargets.mockResolvedValue([target('a')]);
    const { __emitMessageEventNow } = await load();
    await __emitMessageEventNow({ serverId: SERVER, channel: { id: CHANNEL, type: 'text' }, event: 'message_delete', message: { id: 'm9' } });
    expect(enqueueDelivery.mock.calls[0]![0].data).toEqual({ event: 'message_delete', id: 'm9', channelId: CHANNEL });
  });

  it('every queued delivery re-checks the CURRENT bot: permission and channel access', async () => {
    listBotEventTargets.mockResolvedValue([target('a')]);
    const { __emitMessageEventNow } = await load();
    await __emitMessageEventNow({ serverId: SERVER, channel: { id: CHANNEL, type: 'text' }, event: 'message_create', message });
    const { authorize } = enqueueDelivery.mock.calls[0]![0];
    const current = { id: 'a', serverId: SERVER, permissions: ['read_messages', 'receive_events'] };
    getBotReachableChannel.mockResolvedValueOnce({ id: CHANNEL });
    expect(await authorize(current)).toBe(true);
    getBotReachableChannel.mockResolvedValueOnce(null); // access revoked meanwhile
    expect(await authorize(current)).toBe(false);
    expect(await authorize({ ...current, permissions: ['receive_events'] })).toBe(false);
  });

  it('never throws into the request', async () => {
    listBotEventTargets.mockRejectedValue(new Error('db down'));
    const { emitMessageEvent } = await load();
    expect(() => emitMessageEvent({ serverId: SERVER, channel: { id: CHANNEL, type: 'text' }, event: 'message_create', message })).not.toThrow();
  });
});

describe('member events', () => {
  it('publish to each read_members bot’s stream and to subscribed endpoints', async () => {
    listBotEventTargets.mockResolvedValue([
      target('a'),
      target('b', { endpoint: null }),
      target('no-members', { permissions: ['read_messages', 'receive_events'] }),
    ]);
    const { __emitMemberEventNow, botEventsChannel } = await load();
    expect(await __emitMemberEventNow({ serverId: SERVER, userId: USER, event: 'member_leave', reason: 'kick' })).toBe(2);
    const data = { event: 'member_leave', member: { id: USER, displayName: 'Ayşe' }, reason: 'kick' };
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(publish).toHaveBeenCalledWith(botEventsChannel('a'), JSON.stringify(data));
    expect(publish).toHaveBeenCalledWith('lf:test:bot-events:b', JSON.stringify(data));
    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(enqueueDelivery.mock.calls[0]![0]).toMatchObject({ botId: 'a', event: 'member_leave', data });
    expect(await enqueueDelivery.mock.calls[0]![0].authorize({ permissions: ['receive_events'] })).toBe(false);
  });
});

describe('user events and bot changes', () => {
  it('ephemeral answers go to lf:{env}:user-events:{uid}', async () => {
    const { publishUserEvent, userEventsChannel } = await load();
    expect(userEventsChannel(USER)).toBe(`lf:test:user-events:${USER}`);
    await publishUserEvent(USER, { type: 'interaction_response', interaction: { id: 'i' } });
    const [channel, raw] = publish.mock.calls[0]!;
    expect(channel).toBe(`lf:test:user-events:${USER}`);
    expect(JSON.parse(raw)).toMatchObject({ type: 'interaction_response', interaction: { id: 'i' }, at: expect.any(String) });
  });

  it('a bot change drops the cache and tells the gateway (`bot-access`)', async () => {
    listBotEventTargets.mockResolvedValue([]);
    const { getBotEventTargets, notifyBotChanged } = await load();
    await getBotEventTargets(SERVER);
    notifyBotChanged({ serverId: SERVER, botId: 'a', reason: 'channel_access_changed' });
    await vi.waitFor(() =>
      expect(publishAccessInvalidation).toHaveBeenCalledWith({ kind: 'bot-access', serverId: SERVER, botId: 'a', reason: 'channel_access_changed' })
    );
    await getBotEventTargets(SERVER);
    expect(listBotEventTargets).toHaveBeenCalledTimes(2);
  });
});
