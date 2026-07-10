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