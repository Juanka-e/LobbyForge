/**
 * Tests for the activity state bus (lib/activity-bus.ts).
 *
 * Mirrors the chat-bus + presence-bus pattern. We mock @/lib/redis so the
 * tests don't need a real Redis. The subscriber mock captures the `message`
 * handler so tests can drive it directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Handler = (channel: string, raw: string) => void;
type ErrHandler = (err: Error) => void;

interface CapturedSub {
  on: (event: string, h: Handler | ErrHandler) => void;
  off: (event: string, h: Handler | ErrHandler) => void;
  once: (event: string, h: Handler | ErrHandler) => void;
  removeListener: (event: string, h: Handler | ErrHandler) => void;
  listenerCount: (event: string) => number;
  subscribe: (...args: unknown[]) => unknown;
  unsubscribe: (...args: unknown[]) => unknown;
  quit: (...args: unknown[]) => unknown;
  disconnect: () => void;
  status: string;
  messageHandlers: Handler[];
  errorHandlers: ErrHandler[];
}

function makeSub(): CapturedSub {
  const messageHandlers: Handler[] = [];
  const errorHandlers: ErrHandler[] = [];
  const sub: CapturedSub = {
    on: (event: string, h: Handler | ErrHandler) => {
      if (event === 'message') messageHandlers.push(h as Handler);
      else if (event === 'error') errorHandlers.push(h as ErrHandler);
    },
    off: (event: string, h: Handler | ErrHandler) => {
      if (event === 'message') {
        const i = messageHandlers.indexOf(h as Handler);
        if (i >= 0) messageHandlers.splice(i, 1);
      }
    },
    once: (event: string, h: Handler | ErrHandler) => {
      // Emit ready immediately (the bus awaits the ready event).
      if (event === 'ready') {
        setTimeout(() => (h as () => void)(), 0);
      }
    },
    removeListener: () => undefined,
    listenerCount: (event: string) => (event === 'message' ? messageHandlers.length : 0),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
    disconnect: vi.fn(() => undefined),
    status: 'ready',
    messageHandlers,
    errorHandlers,
  };
  return sub;
}

const publish = vi.fn(async (_channel: string, _raw: string) => 1);
const capturedSubs: CapturedSub[] = [];
const duplicate = vi.fn(() => {
  const s = makeSub();
  capturedSubs.push(s);
  return s;
});

vi.mock('../redis', () => ({
  redis: { publish, duplicate },
}));

beforeEach(() => {
  publish.mockReset();
  publish.mockResolvedValue(1);
  duplicate.mockReset();
  capturedSubs.length = 0;
  duplicate.mockImplementation(() => {
    const s = makeSub();
    capturedSubs.push(s);
    return s;
  });
  vi.stubEnv('NODE_ENV', 'test');
  // The module holds module-level Maps (subscribers/states); reset between tests.
  vi.resetModules();
});

const SERVER_ID = 'srv-1';
const SESSION_ID = 'sess-1';
const TOPIC = `lf:test:activity-state:${SERVER_ID}:${SESSION_ID}`;

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe('publishActivityStateChange', () => {
  it('publishes status + state + at to the session topic', async () => {
    const { publishActivityStateChange } = await import('../activity-bus.js');
    publishActivityStateChange({
      serverId: SERVER_ID,
      sessionId: SESSION_ID,
      status: 'running',
      state: { turn: 2 },
    });
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
    const [topic, raw] = publish.mock.calls[0] as [string, string];
    expect(topic).toBe(TOPIC);
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe('running');
    expect(parsed.state).toEqual({ turn: 2 });
    // `at` is injected server-side — assert it is a valid ISO date, not an exact value.
    expect(typeof parsed.at).toBe('string');
    expect(new Date(parsed.at).getTime()).not.toBeNaN();
  });

  it('never throws when publish rejects', async () => {
    publish.mockRejectedValue(new Error('redis down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { publishActivityStateChange } = await import('../activity-bus.js');
    expect(() =>
      publishActivityStateChange({
        serverId: SERVER_ID,
        sessionId: SESSION_ID,
        status: 'running',
        state: {},
      })
    ).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('subscribeActivityStateChange', () => {
  it('forwards parsed messages to the onMessage callback', async () => {
    const { subscribeActivityStateChange } = await import('../activity-bus.js');
    const onMessage = vi.fn();
    await subscribeActivityStateChange(SERVER_ID, SESSION_ID, onMessage);
    await flush();
    const sub = capturedSubs[0]!;
    const msg = { status: 'running', state: { x: 1 }, at: '2026-01-01T00:00:00.000Z' };
    sub.messageHandlers[0]!(TOPIC, JSON.stringify(msg));
    expect(onMessage).toHaveBeenCalledWith(msg);
  });

  it('ignores messages on a different channel', async () => {
    const { subscribeActivityStateChange } = await import('../activity-bus.js');
    const onMessage = vi.fn();
    await subscribeActivityStateChange(SERVER_ID, SESSION_ID, onMessage);
    await flush();
    const sub = capturedSubs[0]!;
    sub.messageHandlers[0]!('lf:test:activity-state:other:other', JSON.stringify({ status: 'x' }));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('drops malformed JSON messages without throwing', async () => {
    const { subscribeActivityStateChange } = await import('../activity-bus.js');
    const onMessage = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await subscribeActivityStateChange(SERVER_ID, SESSION_ID, onMessage);
    await flush();
    const sub = capturedSubs[0]!;
    expect(() => sub.messageHandlers[0]!(TOPIC, 'not-json')).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('unsubscribes but does NOT quit the shared connection when the last listener closes', async () => {
    const { subscribeActivityStateChange } = await import('../activity-bus.js');
    const { close } = await subscribeActivityStateChange(SERVER_ID, SESSION_ID, vi.fn());
    await flush();
    const sub = capturedSubs[0]!;
    close();
    await flush();
    // LF-029: the connection is shared across topics — close() unsubscribes
    // but must NOT quit the connection.
    expect(sub.unsubscribe).toHaveBeenCalledWith(TOPIC);
    expect(sub.quit).not.toHaveBeenCalled();
  });

  it('multiple listeners on the same topic share one connection', async () => {
    const { subscribeActivityStateChange } = await import('../activity-bus.js');
    const a = await subscribeActivityStateChange(SERVER_ID, SESSION_ID, vi.fn());
    const b = await subscribeActivityStateChange(SERVER_ID, SESSION_ID, vi.fn());
    await flush();
    // Only ONE subscriber connection should have been created.
    expect(capturedSubs.length).toBe(1);
    a.close();
    await flush();
    // First close: connection stays (b listening).
    expect(capturedSubs[0]!.quit).not.toHaveBeenCalled();
    b.close();
    await flush();
    // Second close: unsubscribe called, connection STILL stays (shared for other topics).
    expect(capturedSubs[0]!.unsubscribe).toHaveBeenCalledWith(TOPIC);
    expect(capturedSubs[0]!.quit).not.toHaveBeenCalled();
  });
});
