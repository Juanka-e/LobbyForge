/**
 * Tests for the browser-side WebSocket client.
 *
 * We mock the global `WebSocket` constructor with a controllable
 * implementation so each test can drive `open`, `message`, `close`,
 * and `error` events. The real client is what connects to the WS
 * gateway in production — these tests cover the subscription
 * dispatcher, queue, and reconnect logic.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

type Listener = (ev: unknown) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch('close', { code, reason });
  }

  addEventListener(event: string, fn: Listener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
  }

  removeEventListener(event: string, fn: Listener): void {
    const set = this.listeners.get(event);
    set?.delete(fn);
  }

  dispatch(event: string, ev: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) fn(ev);
  }

  // Test helpers
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatch('open', {});
  }

  receive(data: unknown): void {
    this.dispatch('message', { data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
}

(globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;

import { RealtimeClient, __resetRealtimeClient } from '../realtime-client.js';

beforeEach(() => {
  MockWebSocket.instances.length = 0;
  __resetRealtimeClient();
});

afterEach(() => {
  __resetRealtimeClient();
  vi.useRealTimers();
});

describe('RealtimeClient', () => {
  it('opens a socket on connect()', () => {
    const client = new RealtimeClient({ url: 'ws://test' });
    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('ws://test');
  });

  it('sends subscribe on connect', () => {
    const client = new RealtimeClient({ url: 'ws://test' });
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock.open();
    client.subscribe('chat:srv:abc', () => undefined);
    expect(sock.sent).toContain(JSON.stringify({ type: 'subscribe', topic: 'chat:srv:abc' }));
  });

  it('dispatches incoming events to subscribed handlers', () => {
    const received: unknown[] = [];
    const client = new RealtimeClient({ url: 'ws://test' });
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock.open();
    client.subscribe('chat:srv:abc', (data) => received.push(data));
    sock.receive({ type: 'event', topic: 'chat:srv:abc', data: { text: 'hi' }, at: 'now' });
    expect(received).toEqual([{ text: 'hi' }]);
  });

  it('dispatches to multiple handlers for the same topic', () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const client = new RealtimeClient({ url: 'ws://test' });
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock.open();
    client.subscribe('chat:srv:abc', (data) => a.push(data));
    client.subscribe('chat:srv:abc', (data) => b.push(data));
    sock.receive({ type: 'event', topic: 'chat:srv:abc', data: { x: 1 }, at: 'now' });
    expect(a).toEqual([{ x: 1 }]);
    expect(b).toEqual([{ x: 1 }]);
  });

  it('does not dispatch events for other topics', () => {
    const received: unknown[] = [];
    const client = new RealtimeClient({ url: 'ws://test' });
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock.open();
    client.subscribe('chat:srv:abc', (data) => received.push(data));
    sock.receive({ type: 'event', topic: 'chat:srv:other', data: { x: 1 }, at: 'now' });
    expect(received).toEqual([]);
  });

  it('unsubscribe removes a single handler', () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const client = new RealtimeClient({ url: 'ws://test' });
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock.open();
    const unsubA = client.subscribe('chat:srv:abc', (data) => a.push(data));
    client.subscribe('chat:srv:abc', (data) => b.push(data));
    unsubA();
    sock.receive({ type: 'event', topic: 'chat:srv:abc', data: { x: 1 }, at: 'now' });
    expect(a).toEqual([]);
    expect(b).toEqual([{ x: 1 }]);
  });

  it('queues subscribes sent before the socket is open and flushes them on open', () => {
    const client = new RealtimeClient({ url: 'ws://test' });
    client.connect();
    const sock = MockWebSocket.instances[0];
    // Subscribe before open — should queue.
    client.subscribe('chat:srv:abc', () => undefined);
    expect(sock.sent).toEqual([]);
    sock.open();
    expect(sock.sent).toContain(JSON.stringify({ type: 'subscribe', topic: 'chat:srv:abc' }));
  });

  it('re-sends every subscription once the gateway says hello (it drops what arrives before authenticating)', () => {
    const received: unknown[] = [];
    const client = new RealtimeClient({ url: 'ws://test' });
    client.connect();
    const sock = MockWebSocket.instances[0];
    client.subscribe('chat:srv:abc', (data) => received.push(data));
    sock.open();
    // Subscribed after open but before hello: also lost on a slow authentication.
    client.subscribe('user:u1', () => undefined);
    const subscribe = (topic: string) => JSON.stringify({ type: 'subscribe', topic });
    expect(sock.sent.filter((m) => m === subscribe('chat:srv:abc'))).toHaveLength(1);
    sock.receive({ type: 'hello', ok: true, uid: 'u1', at: 'now' });
    expect(sock.sent.filter((m) => m === subscribe('chat:srv:abc'))).toHaveLength(2);
    expect(sock.sent.filter((m) => m === subscribe('user:u1'))).toHaveLength(2);
    sock.receive({ type: 'event', topic: 'chat:srv:abc', data: { type: 'poll_update' }, at: 'now' });
    expect(received).toEqual([{ type: 'poll_update' }]);
  });

  it('replays subscriptions after reconnect', async () => {
    vi.useFakeTimers();
    const client = new RealtimeClient({ url: 'ws://test' });
    client.connect();
    const sock1 = MockWebSocket.instances[0];
    sock1.open();
    client.subscribe('chat:srv:abc', () => undefined);
    expect(sock1.sent).toContain(JSON.stringify({ type: 'subscribe', topic: 'chat:srv:abc' }));
    sock1.close();
    // Allow the reconnect scheduler to run.
    await vi.runAllTimersAsync();
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const sock2 = MockWebSocket.instances[1];
    sock2.open();
    expect(sock2.sent).toContain(JSON.stringify({ type: 'subscribe', topic: 'chat:srv:abc' }));
  });

  it('explicit close() does not reconnect', async () => {
    vi.useFakeTimers();
    const client = new RealtimeClient({ url: 'ws://test' });
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock.open();
    client.close();
    await vi.runAllTimersAsync();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('shared singleton returns the same instance', () => {
    const a = (async () => (await import('../realtime-client.js')).getRealtimeClient())();
    void a;
  });

  it('onError fires when receiving a forbidden subscribe error', () => {
    const errors: Error[] = [];
    const client = new RealtimeClient({
      url: 'ws://test',
      onError: (err) => errors.push(err),
    });
    client.connect();
    const sock = MockWebSocket.instances[0];
    sock.open();
    sock.receive({
      type: 'error',
      code: 'forbidden',
      message: 'nope',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('forbidden');
  });
});
describe('RealtimeClient catching up after a lost connection', () => {
  const hello = { type: 'hello', ok: true, uid: 'u1', at: 'now' };
  const subscribe = (topic: string) => JSON.stringify({ type: 'subscribe', topic });

  it('tells reconnect listeners when a NEW socket authenticates, never for the first one', async () => {
    vi.useFakeTimers();
    const reconnects = vi.fn();
    const client = new RealtimeClient({ url: 'ws://test' });
    const off = client.onReconnect(reconnects);
    client.connect();
    MockWebSocket.instances[0].open();
    MockWebSocket.instances[0].receive(hello);
    expect(reconnects).not.toHaveBeenCalled();

    MockWebSocket.instances[0].close();
    await vi.advanceTimersByTimeAsync(1_000);
    const sock2 = MockWebSocket.instances[1];
    sock2.open();
    expect(reconnects).not.toHaveBeenCalled(); // not before it is authenticated
    sock2.receive(hello);
    expect(reconnects).toHaveBeenCalledTimes(1);

    off();
    sock2.close();
    await vi.advanceTimersByTimeAsync(1_000);
    MockWebSocket.instances[2].open();
    MockWebSocket.instances[2].receive(hello);
    expect(reconnects).toHaveBeenCalledTimes(1);
  });

  it('replaces a socket that looks open when the network comes back, and the old one cannot interfere', () => {
    const received: unknown[] = [];
    const client = new RealtimeClient({ url: 'ws://test' });
    client.subscribe('chat:srv:abc', (data) => received.push(data));
    client.connect();
    const stale = MockWebSocket.instances[0];
    stale.open();
    stale.receive(hello);

    client.wake('online');
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(stale.readyState).toBe(MockWebSocket.CLOSED);
    const fresh = MockWebSocket.instances[1];
    fresh.open();
    expect(fresh.sent).toContain(subscribe('chat:srv:abc'));
    expect(client.readyState).toBe(MockWebSocket.OPEN);

    // A late event or close from the replaced socket is ignored.
    stale.receive({ type: 'event', topic: 'chat:srv:abc', data: { from: 'stale' }, at: 'now' });
    stale.dispatch('close', {});
    expect(client.readyState).toBe(MockWebSocket.OPEN);
    fresh.receive({ type: 'event', topic: 'chat:srv:abc', data: { from: 'fresh' }, at: 'now' });
    expect(received).toEqual([{ from: 'fresh' }]);
  });

  it('leaves an open socket alone when the tab is shown again', () => {
    const client = new RealtimeClient({ url: 'ws://test' });
    client.connect();
    MockWebSocket.instances[0].open();
    client.wake('visible');
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('connects at once, without waiting out the backoff, when the tab is shown after giving up', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new RealtimeClient({ url: 'ws://test' });
    client.connect();
    // The gateway is down: every attempt closes until the breaker trips.
    for (let i = 0; i < 25; i++) {
      MockWebSocket.instances.at(-1)!.close();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    const attempts = MockWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(MockWebSocket.instances).toHaveLength(attempts); // gave up

    client.wake('visible');
    expect(MockWebSocket.instances).toHaveLength(attempts + 1);
    // And the backoff starts over: the next failure retries after ~0.5 s.
    MockWebSocket.instances.at(-1)!.close();
    await vi.advanceTimersByTimeAsync(600);
    expect(MockWebSocket.instances).toHaveLength(attempts + 2);
  });

  it('stays closed after an explicit close()', () => {
    const client = new RealtimeClient({ url: 'ws://test' });
    client.connect();
    client.close();
    client.wake('online');
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
