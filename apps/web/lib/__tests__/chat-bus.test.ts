/**
 * Tests for the chat-bus Redis pub/sub primitive.
 *
 * Mirrors the activity-bus pattern: a topic is `lf:{env}:chat:{serverId}:{channelId}`
 * and the publish path is fire-and-forget. We mock ioredis so the
 * tests don't need a real Redis.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Handler = (channel: string, raw: string) => void;

interface MockSubscriber {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
}

interface MockRedis {
  publish: ReturnType<typeof vi.fn>;
  duplicate: ReturnType<typeof vi.fn>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = ReturnType<typeof vi.fn<any[], any>>;

const subscribers: Array<{ instance: MockSubscriber; handlers: Handler[] }> = [];
let publishImpl: ((channel: string, raw: string) => Promise<unknown>) | null = null;

function makeMockSubscriber(): MockSubscriber {
  const sub: MockSubscriber = {
    on: vi.fn() as AnyMock,
    off: vi.fn() as AnyMock,
    subscribe: vi.fn(async () => undefined) as AnyMock,
    unsubscribe: vi.fn(async () => undefined) as AnyMock,
    quit: vi.fn(async () => undefined) as AnyMock,
  };
  const handlers: Handler[] = [];
  sub.on.mockImplementation((event: string, handler: Handler) => {
    if (event === 'message') handlers.push(handler);
  });
  sub.off.mockImplementation((_event: string, handler: Handler) => {
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  });
  (sub as unknown as { __handlers: Handler[] }).__handlers = handlers;
  subscribers.push({ instance: sub, handlers });
  return sub;
}

function makeMockRedis(): MockRedis {
  return {
    publish: vi.fn(async (channel: string, raw: string) => {
      if (publishImpl) await publishImpl(channel, raw);
      return 1;
    }) as AnyMock,
    duplicate: vi.fn(() => makeMockSubscriber()) as AnyMock,
  };
}

const mocks = vi.hoisted(() => ({
  redis: makeMockRedis(),
  ioredisFactory: vi.fn(() => makeMockSubscriber()),
}));

vi.mock('../redis', () => ({
  redis: mocks.redis,
}));

vi.mock('ioredis', () => ({ default: mocks.ioredisFactory }));

import { publishChatMessage, subscribeChatMessages } from '../chat-bus.js';

const SERVER_ID = 'srv-1';
const CHANNEL_ID = '00000000-0000-0000-0000-000000000010';

beforeEach(() => {
  subscribers.length = 0;
  publishImpl = null;
  mocks.redis.publish.mockClear();
  mocks.redis.duplicate.mockClear();
});

describe('chat-bus', () => {
  it('publishChatMessage sends a JSON envelope to the right topic', async () => {
    const { redis } = await import('../redis');
    publishChatMessage({
      serverId: SERVER_ID,
      channelId: CHANNEL_ID,
      message: {
        id: '00000000-0000-0000-0000-000000000020',
        channelId: CHANNEL_ID,
        userId: '00000000-0000-0000-0000-000000000001',
        content: 'hi',
        metadata: null,
        replyToId: null,
        createdAt: '2026-06-20T00:00:00Z',
      },
    });
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [topic, raw] = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(topic).toBe(`lf:test:chat:${SERVER_ID}:${CHANNEL_ID}`);
    const parsed = JSON.parse(raw);
    expect(parsed.type).toBe('message');
    expect(parsed.message.id).toBe('00000000-0000-0000-0000-000000000020');
    expect(parsed.message.content).toBe('hi');
  });

  it('subscribeChatMessages receives publishes forwarded to the subscriber', async () => {
    const received: Array<{ id: string; content: string }> = [];
    const sub = subscribeChatMessages(SERVER_ID, CHANNEL_ID, (msg) => {
      received.push({ id: msg.message.id, content: msg.message.content });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subscribers[0]?.instance).toBeDefined();
    const topic = `lf:test:chat:${SERVER_ID}:${CHANNEL_ID}`;
    const raw = JSON.stringify({
      type: 'message',
      message: {
        id: '00000000-0000-0000-0000-000000000099',
        channelId: CHANNEL_ID,
        userId: '00000000-0000-0000-0000-000000000001',
        content: 'forwarded',
        metadata: null,
        replyToId: null,
        createdAt: '2026-06-20T00:00:00Z',
      },
      at: new Date().toISOString(),
    });
    for (const entry of subscribers) {
      for (const handler of entry.handlers) handler(topic, raw);
    }
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('00000000-0000-0000-0000-000000000099');
    expect(received[0].content).toBe('forwarded');
    sub.close();
  });

  it('subscribeChatMessages ignores messages on other channels', async () => {
    const received: unknown[] = [];
    const sub = subscribeChatMessages(SERVER_ID, CHANNEL_ID, (msg) => received.push(msg));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const wrongRaw = JSON.stringify({ type: 'message', message: {}, at: new Date().toISOString() });
    for (const entry of subscribers) {
      for (const handler of entry.handlers) handler('lf:test:chat:other:channel', wrongRaw);
    }
    expect(received).toHaveLength(0);
    sub.close();
  });

  it('subscribeChatMessages swallows malformed messages without throwing', async () => {
    const received: unknown[] = [];
    const sub = subscribeChatMessages(SERVER_ID, CHANNEL_ID, (msg) => received.push(msg));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const topic = `lf:test:chat:${SERVER_ID}:${CHANNEL_ID}`;
    for (const entry of subscribers) {
      for (const handler of entry.handlers) handler(topic, '{not json');
    }
    expect(received).toHaveLength(0);
    sub.close();
  });

  it('close() releases the subscriber handle', async () => {
    const sub = subscribeChatMessages(SERVER_ID, CHANNEL_ID, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const subscriber = subscribers[0]?.instance;
    expect(subscriber).toBeDefined();
    sub.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subscriber?.quit).toHaveBeenCalled();
  });

  it('keeps a shared subscriber alive until the last listener closes', async () => {
    const first = subscribeChatMessages(SERVER_ID, CHANNEL_ID, () => undefined);
    const second = subscribeChatMessages(SERVER_ID, CHANNEL_ID, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const subscriber = subscribers[0]?.instance;
    expect(subscriber).toBeDefined();

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subscriber?.quit).not.toHaveBeenCalled();
    expect(subscriber?.unsubscribe).not.toHaveBeenCalled();

    second.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subscriber?.unsubscribe).toHaveBeenCalledWith(`lf:test:chat:${SERVER_ID}:${CHANNEL_ID}`);
    expect(subscriber?.quit).toHaveBeenCalled();
  });
});
