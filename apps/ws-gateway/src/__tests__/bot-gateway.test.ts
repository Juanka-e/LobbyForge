/**
 * Bot API v2 §4 — `/ws/bot` with REAL sockets against the real gateway
 * on an ephemeral port. The database (bot-store) and Redis (subscriber)
 * are faked; everything else — token verification, the one-connection
 * rule, permission and channel filtering, invalidations, the `user:{uid}`
 * browser topic — is the production code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';

const authMocks = vi.hoisted(() => ({
  validateGuestFromHeaders: vi.fn(),
  getRevocationStatus: vi.fn(),
}));
vi.mock('../auth.js', () => authMocks);

vi.mock('../db.js', () => ({ getDb: () => ({ __mockDb: true }) }));

const storeMocks = vi.hoisted(() => ({
  loadBot: vi.fn(),
  listBotFeedChannels: vi.fn(),
  loadFeedMessage: vi.fn(),
  botReachesChannel: vi.fn(),
}));
vi.mock('../bot-store.js', () => storeMocks);

/** A fake Redis bus keyed by wire topic / raw channel name. */
const bus = vi.hoisted(() => {
  const handlers = new Map<string, Set<(raw: string) => void>>();
  const acquire = (key: string, fn: (raw: string) => void) => {
    let set = handlers.get(key);
    if (!set) {
      set = new Set();
      handlers.set(key, set);
    }
    const entry = (raw: string) => fn(raw);
    set.add(entry);
    return {
      release: () => {
        const cur = handlers.get(key);
        cur?.delete(entry);
        if (cur && cur.size === 0) handlers.delete(key);
      },
    };
  };
  return {
    handlers,
    acquire,
    publish(key: string, payload: unknown) {
      for (const fn of [...(handlers.get(key) ?? [])]) fn(typeof payload === 'string' ? payload : JSON.stringify(payload));
    },
    count(key: string) {
      return handlers.get(key)?.size ?? 0;
    },
  };
});
vi.mock('../redis-subscriber.js', () => ({
  acquireTopicSubscription: (topic: string, fn: (raw: string) => void) => bus.acquire(topic, fn),
  acquireRedisChannel: (channel: string, fn: (raw: string) => void) => bus.acquire(channel, fn),
  envPrefix: () => 'test',
  shutdownSubscriber: () => bus.handlers.clear(),
}));

const invalidation = vi.hoisted(() => ({
  handler: null as null | ((event: Record<string, unknown>) => void),
}));
vi.mock('../access-invalidation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../access-invalidation.js')>();
  return {
    ...actual,
    initAccessInvalidationListener: (onEvent: (event: Record<string, unknown>) => void) => {
      invalidation.handler = onEvent;
      return () => {
        invalidation.handler = null;
      };
    },
  };
});

import { __botIpConnectionCount, __ipConnectionCount, createGateway } from '../server.js';
import { hashBotToken } from '../bot-token.js';

const SERVER = '10000000-0000-4000-8000-000000000001';
const BOT_ID = '20000000-0000-4000-8000-000000000001';
const TOKEN = `lfb_${BOT_ID.replace(/-/g, '')}_${'A'.repeat(43)}`;
const WRONG_TOKEN = `lfb_${BOT_ID.replace(/-/g, '')}_${'B'.repeat(43)}`;
const CH1 = '30000000-0000-4000-8000-000000000001';
const CH2 = '30000000-0000-4000-8000-000000000002';
const CH_PRIVATE = '30000000-0000-4000-8000-000000000009';
const MSG = '40000000-0000-4000-8000-000000000001';
const USER = '50000000-0000-4000-8000-000000000001';
const OTHER_USER = '50000000-0000-4000-8000-000000000002';
const BOT_EVENTS = `lf:test:bot-events:${BOT_ID}`;
const chat = (channelId: string) => `chat:${SERVER}:${channelId}`;

const ALL_PERMISSIONS = ['receive_events', 'read_messages', 'read_members', 'slash_commands', 'send_messages'];

function botRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOT_ID,
    serverId: SERVER,
    name: 'Roller',
    type: 'custom',
    tokenHash: hashBotToken(TOKEN),
    permissions: ALL_PERMISSIONS,
    enabled: true,
    ...overrides,
  };
}

function feedMessage(overrides: Record<string, unknown> = {}) {
  return {
    botId: null,
    message: {
      id: MSG,
      channelId: CH1,
      content: '/roll',
      author: { id: USER, displayName: 'Ayşe' },
      createdAt: '2026-10-03T12:00:00.000Z',
      editedAt: null,
      replyToId: null,
      ...overrides,
    },
  };
}

type Frame = Record<string, unknown>;
type TestSocket = WebSocket & { __queue: Frame[]; __closed: Promise<{ code: number; reason: string }> };

function open(url: string, headers: Record<string, string> = {}): TestSocket {
  const ws = new WebSocket(url, { headers }) as TestSocket;
  ws.__queue = [];
  ws.on('message', (raw) => ws.__queue.push(JSON.parse(String(raw)) as Frame));
  ws.__closed = new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  ws.on('error', () => undefined);
  return ws;
}

async function opened(ws: TestSocket): Promise<TestSocket> {
  if (ws.readyState === WebSocket.OPEN) return ws;
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('close', () => reject(new Error('closed before open')));
  });
  return ws;
}

function nextFrame(ws: TestSocket, timeoutMs = 2000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const frame = ws.__queue.shift();
      if (frame) return resolve(frame);
      if (Date.now() - started > timeoutMs) return reject(new Error('message timeout'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

async function noFrame(ws: TestSocket, ms = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  expect(ws.__queue).toEqual([]);
}

function closedWith(ws: TestSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return Promise.race([
    ws.__closed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('close timeout')), timeoutMs)),
  ]);
}

let gateway: ReturnType<typeof createGateway> | null = null;
let base = '';

async function start(): Promise<string> {
  gateway = createGateway();
  await new Promise<void>((resolve) => gateway!.server.once('listening', resolve));
  const addr = gateway.server.address() as AddressInfo;
  base = `ws://127.0.0.1:${addr.port}`;
  return base;
}

/** Connect with the header and drain hello + ready. */
async function connectReady(): Promise<{ ws: TestSocket; hello: Frame; ready: Frame }> {
  const ws = await opened(open(`${base}/ws/bot`, { authorization: `Bot ${TOKEN}` }));
  const hello = await nextFrame(ws);
  const ready = await nextFrame(ws);
  return { ws, hello, ready };
}

beforeEach(() => {
  delete process.env.NODE_ENV;
  process.env.WS_PORT = '0';
  process.env.WS_HOST = '127.0.0.1';
  process.env.WS_BOT_IDENTIFY_TIMEOUT_MS = '200';
  process.env.WS_BOT_AUTH_FAIL_MAX = '3';
  bus.handlers.clear();
  invalidation.handler = null;
  for (const fn of [...Object.values(storeMocks), ...Object.values(authMocks)]) fn.mockReset();
  storeMocks.loadBot.mockResolvedValue(botRow());
  storeMocks.listBotFeedChannels.mockResolvedValue([
    { id: CH1, name: 'general' },
    { id: CH2, name: 'dice' },
  ]);
  storeMocks.loadFeedMessage.mockResolvedValue(feedMessage());
  authMocks.validateGuestFromHeaders.mockReturnValue({ ok: true, guest: { uid: USER, gid: 'g_1', name: 'A' } });
  authMocks.getRevocationStatus.mockResolvedValue('active');
});

afterEach(async () => {
  delete process.env.WS_ALLOWED_ORIGINS;
  delete process.env.WS_BOT_IDENTIFY_TIMEOUT_MS;
  delete process.env.WS_BOT_AUTH_FAIL_MAX;
  await gateway?.close();
  gateway = null;
});

describe('authentication', () => {
  it('Authorization header → hello, then ready with the §1.1 channels; feed subscribed', async () => {
    await start();
    const { hello, ready } = await connectReady();
    expect(hello).toMatchObject({ type: 'hello', ok: true, bot: { id: BOT_ID, serverId: SERVER } });
    expect(ready).toMatchObject({
      type: 'event',
      topic: 'bot',
      data: {
        event: 'ready',
        bot: { id: BOT_ID, name: 'Roller', serverId: SERVER, permissions: ALL_PERMISSIONS },
        channels: [
          { id: CH1, name: 'general' },
          { id: CH2, name: 'dice' },
        ],
      },
    });
    expect(bus.count(chat(CH1))).toBe(1);
    expect(bus.count(chat(CH2))).toBe(1);
    expect(bus.count(BOT_EVENTS)).toBe(1);
    expect(storeMocks.loadBot).toHaveBeenCalledWith({ __mockDb: true }, BOT_ID);
  });

  it('identify message (no header) → hello + ready', async () => {
    await start();
    const ws = await opened(open(`${base}/ws/bot`));
    ws.send(JSON.stringify({ type: 'identify', token: TOKEN }));
    expect((await nextFrame(ws)).type).toBe('hello');
    expect(((await nextFrame(ws)).data as Frame).event).toBe('ready');
    ws.close();
  });

  it('no identify within the time limit → 4001', async () => {
    await start();
    const ws = await opened(open(`${base}/ws/bot`));
    expect(await nextFrame(ws, 1000)).toMatchObject({ type: 'error', code: 'unauthorized' });
    expect((await closedWith(ws)).code).toBe(4001);
    expect(storeMocks.loadBot).not.toHaveBeenCalled();
  });

  it('any other first message → 4001', async () => {
    await start();
    const ws = await opened(open(`${base}/ws/bot`));
    ws.send(JSON.stringify({ type: 'subscribe', topic: chat(CH1) }));
    expect((await closedWith(ws)).code).toBe(4001);
    expect(bus.count(chat(CH1))).toBe(0);
  });

  it('a wrong secret, a malformed header or a non-custom bot → 4001', async () => {
    await start();
    const wrong = await opened(open(`${base}/ws/bot`, { authorization: `Bot ${WRONG_TOKEN}` }));
    expect(await nextFrame(wrong)).toMatchObject({ type: 'error', code: 'unauthorized' });
    expect((await closedWith(wrong)).code).toBe(4001);

    const malformed = await opened(open(`${base}/ws/bot`, { authorization: 'Bearer nope' }));
    expect((await closedWith(malformed)).code).toBe(4001);
    expect(storeMocks.loadBot).toHaveBeenCalledTimes(1); // no lookup for a malformed token

    storeMocks.loadBot.mockResolvedValue(botRow({ type: 'welcome' }));
    const builtIn = await opened(open(`${base}/ws/bot`, { authorization: `Bot ${TOKEN}` }));
    expect((await closedWith(builtIn)).code).toBe(4001);
  });

  it('a revoked token (no hash) or a deleted bot → 4001', async () => {
    await start();
    storeMocks.loadBot.mockResolvedValue(botRow({ tokenHash: null }));
    const revoked = await opened(open(`${base}/ws/bot`, { authorization: `Bot ${TOKEN}` }));
    expect((await closedWith(revoked)).code).toBe(4001);
    storeMocks.loadBot.mockResolvedValue(null);
    const gone = await opened(open(`${base}/ws/bot`, { authorization: `Bot ${TOKEN}` }));
    expect((await closedWith(gone)).code).toBe(4001);
  });

  it('a disabled bot → 4003 bot_disabled', async () => {
    storeMocks.loadBot.mockResolvedValue(botRow({ enabled: false }));
    await start();
    const ws = await opened(open(`${base}/ws/bot`, { authorization: `Bot ${TOKEN}` }));
    expect(await nextFrame(ws)).toMatchObject({ type: 'error', code: 'bot_disabled' });
    expect((await closedWith(ws)).code).toBe(4003);
  });

  it('without receive_events → 4003 missing_permission', async () => {
    storeMocks.loadBot.mockResolvedValue(botRow({ permissions: ['read_messages'] }));
    await start();
    const ws = await opened(open(`${base}/ws/bot`, { authorization: `Bot ${TOKEN}` }));
    expect(await nextFrame(ws)).toMatchObject({
      type: 'error',
      code: 'missing_permission',
      permission: 'receive_events',
    });
    expect((await closedWith(ws)).code).toBe(4003);
    expect(bus.count(BOT_EVENTS)).toBe(0);
  });

  it('a database failure during the handshake → 1011, without leaking the error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    storeMocks.loadBot.mockRejectedValue(new Error('select "token_hash" from "bots" where ...'));
    await start();
    const ws = await opened(open(`${base}/ws/bot`, { authorization: `Bot ${TOKEN}` }));
    const frame = await nextFrame(ws);
    expect(frame).toMatchObject({ type: 'error', code: 'internal_error' });
    expect(JSON.stringify(frame)).not.toMatch(/token_hash|select/);
    expect((await closedWith(ws)).code).toBe(1011);
    warn.mockRestore();
  });

  it('too many failed identifies from one address → 4029 before any lookup', async () => {
    await start();
    for (let i = 0; i < 3; i += 1) {
      const ws = await opened(open(`${base}/ws/bot`, { authorization: `Bot ${WRONG_TOKEN}` }));
      expect((await closedWith(ws)).code).toBe(4001);
    }
    expect(storeMocks.loadBot).toHaveBeenCalledTimes(3);
    const limited = await opened(open(`${base}/ws/bot`, { authorization: `Bot ${TOKEN}` }));
    expect(await nextFrame(limited)).toMatchObject({ type: 'error', code: 'rate_limited' });
    expect((await closedWith(limited)).code).toBe(4029);
    expect(storeMocks.loadBot).toHaveBeenCalledTimes(3);
  });

  it('needs no cookie and no Origin, even in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOWED_ORIGINS = 'https://chat.example.com';
    await start();
    const ws = await opened(open(`${base}/ws/bot`, { authorization: `Bot ${TOKEN}` }));
    expect((await nextFrame(ws)).type).toBe('hello');
    const foreign = await opened(open(`${base}/ws/bot`, { origin: 'https://elsewhere.example' }));
    foreign.send(JSON.stringify({ type: 'identify', token: TOKEN }));
    expect((await nextFrame(foreign)).type).toBe('hello');
    // The browser path keeps its origin rule.
    const browser = open(`${base}/ws`, { cookie: 'lf_guest=x', origin: 'https://elsewhere.example' });
    await expect(opened(browser)).rejects.toThrow();
    expect(authMocks.validateGuestFromHeaders).not.toHaveBeenCalled();
    foreign.close();
  });

  it('counts bot sockets per address apart from browser sockets', async () => {
    await start();
    const { ws } = await connectReady();
    const loopback = (fn: (ip: string) => number) => fn('127.0.0.1') + fn('::ffff:127.0.0.1');
    expect(loopback(__botIpConnectionCount)).toBe(1);
    expect(loopback(__ipConnectionCount)).toBe(0);
    ws.close();
    await vi.waitFor(() => expect(loopback(__botIpConnectionCount)).toBe(0));
  });
});

describe('one connection per bot', () => {
  it('a newer connection closes the older one with 4009 and takes over the feed', async () => {
    await start();
    const first = await connectReady();
    const second = await connectReady();
    expect(await nextFrame(first.ws)).toMatchObject({ type: 'error', code: 'replaced' });
    expect((await closedWith(first.ws)).code).toBe(4009);
    expect(second.hello.type).toBe('hello');
    // Only the new connection holds the subscriptions.
    expect(bus.count(chat(CH1))).toBe(1);
    expect(bus.count(BOT_EVENTS)).toBe(1);
    bus.publish(chat(CH1), { type: 'message', message: { id: MSG, channelId: CH1, userId: USER }, at: 't1' });
    expect(((await nextFrame(second.ws)).data as Frame).event).toBe('message_create');
    second.ws.close();
  });
});

describe('feed filtering', () => {
  it('forwards a message from an accessible channel, loaded from the database', async () => {
    await start();
    const { ws } = await connectReady();
    bus.publish(chat(CH1), {
      type: 'message',
      message: { id: MSG, channelId: CH1, userId: USER, content: 'publisher text is not trusted' },
      at: '2026-10-03T12:00:00.000Z',
    });
    const frame = await nextFrame(ws);
    expect(frame).toMatchObject({ type: 'event', topic: 'bot', data: { event: 'message_create' } });
    expect((frame.data as Frame).message).toEqual(feedMessage().message);
    expect(storeMocks.loadFeedMessage).toHaveBeenCalledWith(
      { __mockDb: true },
      MSG,
      CH1,
      'message:2026-10-03T12:00:00.000Z'
    );
    ws.close();
  });

  it('never subscribes to (or forwards from) a channel outside the set', async () => {
    await start();
    const { ws } = await connectReady();
    expect(bus.count(chat(CH_PRIVATE))).toBe(0);
    bus.publish(chat(CH_PRIVATE), { type: 'message', message: { id: MSG, channelId: CH_PRIVATE, userId: USER } });
    await noFrame(ws);
    ws.close();
  });

  it('without read_messages: no message events, no message reads', async () => {
    storeMocks.loadBot.mockResolvedValue(botRow({ permissions: ['receive_events', 'slash_commands'] }));
    await start();
    const { ws } = await connectReady();
    bus.publish(chat(CH1), { type: 'message', message: { id: MSG, channelId: CH1, userId: USER } });
    bus.publish(chat(CH1), { type: 'message_delete', id: MSG, channelId: CH1 });
    await noFrame(ws);
    expect(storeMocks.loadFeedMessage).not.toHaveBeenCalled();
    ws.close();
  });

  it("never forwards the bot's own messages", async () => {
    await start();
    const { ws } = await connectReady();
    bus.publish(chat(CH1), { type: 'message', message: { id: MSG, channelId: CH1, userId: null, botId: BOT_ID } });
    await noFrame(ws);
    expect(storeMocks.loadFeedMessage).not.toHaveBeenCalled();
    // Even when the publisher left botId out, the stored row decides.
    storeMocks.loadFeedMessage.mockResolvedValue({ ...feedMessage(), botId: BOT_ID });
    bus.publish(chat(CH1), { type: 'message', message: { id: MSG, channelId: CH1 } });
    await noFrame(ws);
    ws.close();
  });

  it('drops a message whose row is gone, and ignores malformed bus payloads', async () => {
    await start();
    const { ws } = await connectReady();
    storeMocks.loadFeedMessage.mockResolvedValue(null);
    bus.publish(chat(CH1), { type: 'message', message: { id: MSG, channelId: CH1 } });
    bus.publish(chat(CH1), 'not json');
    bus.publish(chat(CH1), { type: 'message', message: { id: 'not-a-uuid' } });
    bus.publish(chat(CH1), { type: 'reaction', message: { id: MSG } });
    await noFrame(ws);
    expect(storeMocks.loadFeedMessage).toHaveBeenCalledTimes(1);
    ws.close();
  });

  it('forwards updates and deletes; a delete names the topic channel, not the publisher claim', async () => {
    await start();
    const { ws } = await connectReady();
    storeMocks.loadFeedMessage.mockResolvedValue(feedMessage({ content: 'edited', editedAt: '2026-10-03T12:01:00.000Z' }));
    bus.publish(chat(CH1), { type: 'message_update', message: { id: MSG, channelId: CH1 }, at: 't2' });
    const update = await nextFrame(ws);
    expect(update.data).toMatchObject({ event: 'message_update', message: { content: 'edited' } });
    bus.publish(chat(CH1), { type: 'message_delete', id: MSG, channelId: CH_PRIVATE });
    expect((await nextFrame(ws)).data).toEqual({ event: 'message_delete', id: MSG, channelId: CH1 });
    ws.close();
  });

  it('keeps bus order even when an earlier message loads slowly', async () => {
    await start();
    const { ws } = await connectReady();
    const MSG2 = '40000000-0000-4000-8000-000000000002';
    let releaseFirst: (value: unknown) => void = () => undefined;
    storeMocks.loadFeedMessage
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = () => resolve(feedMessage()); }))
      .mockResolvedValueOnce(feedMessage({ id: MSG2 }));
    bus.publish(chat(CH1), { type: 'message', message: { id: MSG, channelId: CH1 }, at: 'a' });
    bus.publish(chat(CH1), { type: 'message', message: { id: MSG2, channelId: CH1 }, at: 'b' });
    await new Promise((r) => setTimeout(r, 30));
    releaseFirst(undefined);
    expect(((await nextFrame(ws)).data as { message: Frame }).message.id).toBe(MSG);
    expect(((await nextFrame(ws)).data as { message: Frame }).message.id).toBe(MSG2);
    ws.close();
  });
});

describe('bot-events channel', () => {
  const interaction = {
    event: 'interaction_create',
    interaction: {
      id: '60000000-0000-4000-8000-000000000001',
      commandName: 'roll',
      options: { sides: 20 },
      channelId: CH2,
      user: { id: USER, displayName: 'Ayşe' },
      expiresAt: '2026-10-03T12:15:00.000Z',
    },
  };
  const join = { event: 'member_join', member: { id: OTHER_USER, displayName: 'Mert' } };

  it('forwards interactions (slash_commands) and member events (read_members)', async () => {
    await start();
    const { ws } = await connectReady();
    bus.publish(BOT_EVENTS, interaction);
    expect(await nextFrame(ws)).toMatchObject({ type: 'event', topic: 'bot', data: interaction });
    bus.publish(BOT_EVENTS, join);
    expect((await nextFrame(ws)).data).toEqual(join);
    bus.publish(BOT_EVENTS, { data: { ...join, event: 'member_leave' } });
    expect(((await nextFrame(ws)).data as Frame).event).toBe('member_leave');
    ws.close();
  });

  it('drops them without the permission', async () => {
    storeMocks.loadBot.mockResolvedValue(botRow({ permissions: ['receive_events', 'read_messages'] }));
    await start();
    const { ws } = await connectReady();
    bus.publish(BOT_EVENTS, interaction);
    bus.publish(BOT_EVENTS, join);
    await noFrame(ws);
    ws.close();
  });

  it('re-checks channel access: an interaction in a channel the bot no longer reaches is dropped', async () => {
    await start();
    const { ws } = await connectReady();
    bus.publish(BOT_EVENTS, { ...interaction, interaction: { ...interaction.interaction, channelId: CH_PRIVATE } });
    bus.publish(BOT_EVENTS, { ...interaction, interaction: { ...interaction.interaction, channelId: 'not-a-uuid' } });
    bus.publish(BOT_EVENTS, { event: 'interaction_create', interaction: { id: 'x' } });
    await noFrame(ws);
    // Below the cap the live set is complete: no database read per interaction.
    expect(storeMocks.botReachesChannel).not.toHaveBeenCalled();
    // Access revoked after the command ran: the bot's set no longer has CH2.
    storeMocks.listBotFeedChannels.mockResolvedValue([{ id: CH1, name: 'general' }]);
    invalidation.handler!({ kind: 'bot-access', botId: BOT_ID, serverId: SERVER });
    expect(((await nextFrame(ws)).data as Frame).event).toBe('channel_access_changed');
    bus.publish(BOT_EVENTS, interaction);
    await noFrame(ws);
    ws.close();
  });

  it('a bot in selected mode with no channel left hears no interaction at all', async () => {
    storeMocks.listBotFeedChannels.mockResolvedValue([]);
    await start();
    const { ws, ready } = await connectReady();
    expect((ready.data as { channels: unknown[] }).channels).toEqual([]);
    bus.publish(BOT_EVENTS, interaction);
    await noFrame(ws);
    ws.close();
  });

  it('beyond a capped channel set, the database decides', async () => {
    process.env.WS_BOT_MAX_CHANNELS = '2';
    try {
      await start();
      const { ws } = await connectReady(); // CH1 + CH2: the set is at the cap
      storeMocks.botReachesChannel.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const beyond = { ...interaction, interaction: { ...interaction.interaction, channelId: CH_PRIVATE } };
      bus.publish(BOT_EVENTS, beyond);
      expect(((await nextFrame(ws)).data as { interaction: Frame }).interaction.channelId).toBe(CH_PRIVATE);
      bus.publish(BOT_EVENTS, beyond);
      await noFrame(ws);
      expect(storeMocks.botReachesChannel).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: BOT_ID, serverId: SERVER }), CH_PRIVATE);
      ws.close();
    } finally {
      delete process.env.WS_BOT_MAX_CHANNELS;
    }
  });

  it('never forwards gateway-made or message events pushed on the bot channel', async () => {
    await start();
    const { ws } = await connectReady();
    bus.publish(BOT_EVENTS, { event: 'ready', bot: {}, channels: [{ id: CH_PRIVATE, name: 'x' }] });
    bus.publish(BOT_EVENTS, { event: 'channel_access_changed', channels: [] });
    bus.publish(BOT_EVENTS, { event: 'message_create', message: { id: MSG, channelId: CH_PRIVATE } });
    bus.publish(BOT_EVENTS, { event: 'anything_else' });
    await noFrame(ws);
    ws.close();
  });
});

describe('access invalidation', () => {
  it('bot-access recomputes the channel set: channel_access_changed, subscriptions follow', async () => {
    await start();
    const { ws } = await connectReady();
    storeMocks.listBotFeedChannels.mockResolvedValue([{ id: CH2, name: 'dice' }, { id: CH_PRIVATE, name: 'ops' }]);
    invalidation.handler!({ kind: 'bot-access', botId: BOT_ID, serverId: SERVER });
    expect((await nextFrame(ws)).data).toEqual({
      event: 'channel_access_changed',
      channels: [{ id: CH2, name: 'dice' }, { id: CH_PRIVATE, name: 'ops' }],
    });
    expect(bus.count(chat(CH1))).toBe(0);
    expect(bus.count(chat(CH_PRIVATE))).toBe(1);
    bus.publish(chat(CH1), { type: 'message', message: { id: MSG, channelId: CH1 } });
    await noFrame(ws);
    ws.close();
  });

  it('a message still loading when access is revoked is dropped', async () => {
    await start();
    const { ws } = await connectReady();
    let finish: () => void = () => undefined;
    storeMocks.loadFeedMessage.mockImplementationOnce(
      () => new Promise((resolve) => { finish = () => resolve(feedMessage()); })
    );
    bus.publish(chat(CH1), { type: 'message', message: { id: MSG, channelId: CH1 } });
    await vi.waitFor(() => expect(storeMocks.loadFeedMessage).toHaveBeenCalled());
    storeMocks.listBotFeedChannels.mockResolvedValue([{ id: CH2, name: 'dice' }]);
    invalidation.handler!({ kind: 'bot-access', botId: BOT_ID });
    expect(((await nextFrame(ws)).data as Frame).event).toBe('channel_access_changed');
    finish();
    await noFrame(ws);
    ws.close();
  });

  it('a disabled bot, a lost receive_events or a rotated token closes the socket', async () => {
    await start();
    let { ws } = await connectReady();
    storeMocks.loadBot.mockResolvedValue(botRow({ enabled: false }));
    invalidation.handler!({ kind: 'bot-access', botId: BOT_ID });
    expect((await closedWith(ws)).code).toBe(4003);
    expect(bus.count(BOT_EVENTS)).toBe(0);

    storeMocks.loadBot.mockResolvedValue(botRow());
    ({ ws } = await connectReady());
    storeMocks.loadBot.mockResolvedValue(botRow({ permissions: ['read_messages'] }));
    invalidation.handler!({ kind: 'bot-access', botId: BOT_ID });
    expect((await closedWith(ws)).code).toBe(4003);

    storeMocks.loadBot.mockResolvedValue(botRow());
    ({ ws } = await connectReady());
    storeMocks.loadBot.mockResolvedValue(botRow({ tokenHash: hashBotToken(WRONG_TOKEN) }));
    invalidation.handler!({ kind: 'bot-access', botId: BOT_ID });
    expect((await closedWith(ws)).code).toBe(4001);
  });

  it('a lost permission stops those events without closing', async () => {
    await start();
    const { ws } = await connectReady();
    storeMocks.loadBot.mockResolvedValue(botRow({ permissions: ['receive_events', 'read_members'] }));
    invalidation.handler!({ kind: 'bot-access', botId: BOT_ID });
    expect(((await nextFrame(ws)).data as Frame).event).toBe('channel_access_changed');
    bus.publish(chat(CH1), { type: 'message', message: { id: MSG, channelId: CH1 } });
    await noFrame(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('a channel policy change in its server re-checks; unchanged sets send nothing', async () => {
    await start();
    const { ws } = await connectReady();
    invalidation.handler!({ kind: 'channel-policy', serverId: SERVER, channelId: CH1, reason: 'permissions_changed' });
    await vi.waitFor(() => expect(storeMocks.listBotFeedChannels).toHaveBeenCalledTimes(2));
    await noFrame(ws);
    storeMocks.listBotFeedChannels.mockResolvedValue([{ id: CH2, name: 'dice' }]);
    invalidation.handler!({ kind: 'channel-policy', serverId: SERVER, channelId: CH1, reason: 'permissions_changed' });
    expect((await nextFrame(ws)).data).toEqual({ event: 'channel_access_changed', channels: [{ id: CH2, name: 'dice' }] });
    ws.close();
  });

  it('events for another bot or server change nothing', async () => {
    await start();
    const { ws } = await connectReady();
    invalidation.handler!({ kind: 'bot-access', botId: '20000000-0000-4000-8000-000000000099' });
    invalidation.handler!({ kind: 'server-policy', serverId: '10000000-0000-4000-8000-000000000099', reason: 'x' });
    await noFrame(ws);
    expect(storeMocks.loadBot).toHaveBeenCalledTimes(1);
    ws.close();
  });
});

describe('after identify', () => {
  it('answers ping with pong and refuses anything else', async () => {
    await start();
    const { ws } = await connectReady();
    ws.send(JSON.stringify({ type: 'ping' }));
    expect((await nextFrame(ws)).type).toBe('pong');
    ws.send(JSON.stringify({ type: 'subscribe', topic: chat(CH_PRIVATE) }));
    expect(await nextFrame(ws)).toMatchObject({ type: 'error', code: 'bad_message' });
    ws.send(JSON.stringify({ type: 'identify', token: TOKEN }));
    expect(await nextFrame(ws)).toMatchObject({ type: 'error', code: 'bad_message' });
    expect(bus.count(chat(CH_PRIVATE))).toBe(0);
    ws.close();
  });
});

describe('the SDK against the real gateway', () => {
  it('LobbyForgeBot identifies, receives typed events, and stops for good when replaced (4009)', async () => {
    const { LobbyForgeBot } = await import('../../../../packages/bot-sdk/src/index.js');
    await start();
    const http = base.replace('ws://', 'http://');
    const options = {
      baseUrl: http,
      token: TOKEN,
      gatewayUrl: `${base}/ws/bot`,
      WebSocket: WebSocket as never,
      fetch: (async () => new Response('{}')) as typeof fetch,
    };
    const first = new LobbyForgeBot(options);
    const messages: unknown[] = [];
    first.on('message', (m) => {
      messages.push(m);
    });
    const firstError = new Promise<Error>((resolve) => first.on('error', resolve));
    await first.connect();
    expect(first.ready?.channels).toEqual([
      { id: CH1, name: 'general' },
      { id: CH2, name: 'dice' },
    ]);

    bus.publish(chat(CH1), { type: 'message', message: { id: MSG, channelId: CH1, userId: USER }, at: 't' });
    await vi.waitFor(() => expect(messages).toEqual([feedMessage().message]));

    const second = new LobbyForgeBot(options);
    await second.connect();
    const error = await firstError;
    expect((error as Error & { code?: string }).code).toBe('replaced');
    await new Promise((r) => setTimeout(r, 1200));
    // The replaced bot did not come back and steal the stream.
    expect(gateway!.server.listening).toBe(true);
    expect(bus.count(BOT_EVENTS)).toBe(1);
    second.close();
  });
});

describe('user:{uid} browser topic (§4.3)', () => {
  it('only the session with that uid can subscribe; events are forwarded', async () => {
    await start();
    const ws = await opened(open(base, { cookie: 'lf_guest=x' }));
    expect((await nextFrame(ws)).type).toBe('hello');
    ws.send(JSON.stringify({ type: 'subscribe', topic: `user:${OTHER_USER}` }));
    expect(await nextFrame(ws)).toMatchObject({ type: 'error', code: 'forbidden', topic: `user:${OTHER_USER}` });
    expect(bus.count(`user:${OTHER_USER}`)).toBe(0);

    ws.send(JSON.stringify({ type: 'subscribe', topic: `user:${USER}` }));
    expect(await nextFrame(ws)).toMatchObject({ type: 'subscribed', topic: `user:${USER}` });
    const answer = {
      type: 'interaction_response',
      interaction: { id: '60000000-0000-4000-8000-000000000001', channelId: CH2 },
      response: { content: 'You rolled 17', ephemeral: true },
    };
    bus.publish(`user:${USER}`, answer);
    expect(await nextFrame(ws)).toMatchObject({ type: 'event', topic: `user:${USER}`, data: answer });
    ws.close();
  });
});
