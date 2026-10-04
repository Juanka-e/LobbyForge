/**
 * Bot API v2 §4.1 lifecycle, driven directly (fake socket, no timers):
 *   - heartbeat: ping + `heartbeat` frame each tick; a bot that misses two
 *     pings is terminated; a pong or a `ping` message keeps it alive;
 *   - periodic refresh: catches a lost invalidation (channel set changed →
 *     channel_access_changed once), tolerates a database blip;
 *   - a bot-access invalidation that cannot be evaluated fails closed
 *     (message subscriptions dropped) until a refresh succeeds.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type * as http from 'node:http';

const storeMocks = vi.hoisted(() => ({
  loadBot: vi.fn(),
  listBotFeedChannels: vi.fn(),
  loadFeedMessage: vi.fn(),
}));
vi.mock('../bot-store.js', () => storeMocks);

const bus = vi.hoisted(() => {
  const counts = new Map<string, number>();
  const acquire = (key: string) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        counts.set(key, (counts.get(key) ?? 1) - 1);
      },
    };
  };
  return { counts, acquire };
});
vi.mock('../redis-subscriber.js', () => ({
  acquireTopicSubscription: (topic: string) => bus.acquire(topic),
  acquireRedisChannel: (channel: string) => bus.acquire(channel),
  envPrefix: () => 'test',
}));

import { createBotGateway } from '../bot-gateway.js';
import { hashBotToken } from '../bot-token.js';

const SERVER = '10000000-0000-4000-8000-000000000001';
const BOT_ID = '20000000-0000-4000-8000-000000000001';
const TOKEN = `lfb_${BOT_ID.replace(/-/g, '')}_${'A'.repeat(43)}`;
const CH1 = '30000000-0000-4000-8000-000000000001';
const CH2 = '30000000-0000-4000-8000-000000000002';

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  ping = vi.fn();
  terminate = vi.fn(() => {
    this.readyState = 3;
    this.emit('close', 1006, Buffer.alloc(0));
  });
  close = vi.fn((code?: number) => {
    this.readyState = 3;
    this.emit('close', code ?? 1005, Buffer.alloc(0));
  });
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  frames(type: string): Record<string, unknown>[] {
    return this.sent.filter((f) => f.type === type);
  }
  events(name: string): Record<string, unknown>[] {
    return this.sent.filter((f) => f.type === 'event' && (f.data as { event?: string }).event === name);
  }
}

function botRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOT_ID,
    serverId: SERVER,
    name: 'Roller',
    type: 'custom',
    tokenHash: hashBotToken(TOKEN),
    permissions: ['receive_events', 'read_messages'],
    enabled: true,
    ...overrides,
  };
}

async function connect(gateway: ReturnType<typeof createBotGateway>) {
  const socket = new FakeSocket();
  const release = vi.fn();
  const req = { headers: { authorization: `Bot ${TOKEN}` } } as unknown as http.IncomingMessage;
  gateway.handleConnection(socket as unknown as WebSocket, req, '203.0.113.7', release);
  await vi.waitFor(() => expect(socket.events('ready')).toHaveLength(1));
  return { socket, release };
}

beforeEach(() => {
  bus.counts.clear();
  for (const fn of Object.values(storeMocks)) fn.mockReset();
  storeMocks.loadBot.mockResolvedValue(botRow());
  storeMocks.listBotFeedChannels.mockResolvedValue([{ id: CH1, name: 'general' }]);
});

describe('heartbeat', () => {
  it('pings with a heartbeat frame and terminates a bot that misses two pings', async () => {
    const gateway = createBotGateway({ getDb: () => ({}) });
    const { socket, release } = await connect(gateway);

    gateway.heartbeat();
    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(socket.frames('heartbeat')).toHaveLength(1);
    gateway.heartbeat(); // second ping still unanswered — allowed
    expect(socket.terminate).not.toHaveBeenCalled();
    gateway.heartbeat(); // two missed → terminated
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(gateway.stats().connections).toBe(0);
    expect(bus.counts.get(`chat:${SERVER}:${CH1}`)).toBe(0);
    expect(bus.counts.get(`lf:test:bot-events:${BOT_ID}`)).toBe(0);
    expect(release).toHaveBeenCalled();
  });

  it('a pong or an application ping keeps the bot alive', async () => {
    const gateway = createBotGateway({ getDb: () => ({}) });
    const { socket } = await connect(gateway);
    for (let i = 0; i < 5; i += 1) {
      gateway.heartbeat();
      if (i % 2 === 0) socket.emit('pong');
      else socket.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })));
    }
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.frames('pong').length).toBeGreaterThan(0);
  });

  it('a bot flooding messages is closed with 4029', async () => {
    const gateway = createBotGateway({ getDb: () => ({}), inboundMax: 3 });
    const { socket } = await connect(gateway);
    for (let i = 0; i < 4; i += 1) socket.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })));
    expect(socket.close).toHaveBeenCalledWith(4029, 'rate_limited');
    expect(socket.frames('pong')).toHaveLength(3);
  });

  it('too many connects for one bot are refused with 4029', async () => {
    const gateway = createBotGateway({ getDb: () => ({}), connectMax: 2 });
    await connect(gateway);
    await connect(gateway);
    const socket = new FakeSocket();
    const req = { headers: { authorization: `Bot ${TOKEN}` } } as unknown as http.IncomingMessage;
    gateway.handleConnection(socket as unknown as WebSocket, req, '203.0.113.7', vi.fn());
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalledWith(4029, 'rate_limited'));
  });
});

describe('periodic refresh', () => {
  it('announces a changed channel set once, and nothing when unchanged', async () => {
    const gateway = createBotGateway({ getDb: () => ({}) });
    const { socket } = await connect(gateway);
    await gateway.refreshAll();
    expect(socket.events('channel_access_changed')).toHaveLength(0);

    storeMocks.listBotFeedChannels.mockResolvedValue([{ id: CH1, name: 'general' }, { id: CH2, name: 'dice' }]);
    await gateway.refreshAll();
    await gateway.refreshAll();
    expect(socket.events('channel_access_changed')).toHaveLength(1);
    expect(gateway.stats().channels[BOT_ID]).toEqual([CH1, CH2]);
  });

  it('keeps the feed through a database blip', async () => {
    const gateway = createBotGateway({ getDb: () => ({}) });
    const { socket } = await connect(gateway);
    storeMocks.loadBot.mockRejectedValueOnce(new Error('db down'));
    await gateway.refreshAll();
    expect(gateway.stats().channels[BOT_ID]).toEqual([CH1]);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('closes the socket when the token was rotated since it connected', async () => {
    const gateway = createBotGateway({ getDb: () => ({}) });
    const { socket } = await connect(gateway);
    storeMocks.loadBot.mockResolvedValue(botRow({ tokenHash: hashBotToken(`${TOKEN.slice(0, -1)}B`) }));
    await gateway.refreshAll();
    expect(socket.close).toHaveBeenCalledWith(4001, 'unauthorized');
    expect(gateway.stats().connections).toBe(0);
  });
});

describe('fail closed', () => {
  it('a bot-access change that cannot be evaluated drops message subscriptions until a refresh succeeds', async () => {
    const gateway = createBotGateway({ getDb: () => ({}) });
    const { socket } = await connect(gateway);
    storeMocks.listBotFeedChannels.mockRejectedValueOnce(new Error('db down'));
    gateway.onInvalidation({ kind: 'bot-access', botId: BOT_ID });
    await vi.waitFor(() => expect(gateway.stats().channels[BOT_ID]).toEqual([]));
    expect(bus.counts.get(`chat:${SERVER}:${CH1}`)).toBe(0);
    expect(socket.events('channel_access_changed')).toHaveLength(0);

    await gateway.refreshAll();
    expect(gateway.stats().channels[BOT_ID]).toEqual([CH1]);
    // The bot was never told it lost the channel, so nothing to re-announce.
    expect(socket.events('channel_access_changed')).toHaveLength(0);
  });
});
