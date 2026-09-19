/**
 * beta-review (S6): the gateway multiplexes EVERY topic over ONE shared
 * Redis subscriber connection with SUBSCRIBE/UNSUBSCRIBE refcounting.
 * The old pool opened a new connection per unique topic — a member
 * could exhaust Redis connections by subscribing to many topics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSubscriberState,
  __setConnectionFactory,
  __subscriberStats,
  acquireTopicSubscription,
  type SubscriberConnection,
} from '../redis-subscriber.js';

class FakeConnection implements SubscriberConnection {
  subscribe = vi.fn(async (_channel: string) => 1);
  unsubscribe = vi.fn(async (_channel: string) => 0);
  quit = vi.fn(async () => 'OK');
  private messageListeners: Array<(channel: string, raw: string) => void> = [];
  on(event: 'message' | 'error', listener: (...args: never[]) => void): this {
    if (event === 'message') this.messageListeners.push(listener as (channel: string, raw: string) => void);
    return this;
  }
  emitMessage(channel: string, raw: string): void {
    for (const l of this.messageListeners) l(channel, raw);
  }
  get messageListenerCount(): number {
    return this.messageListeners.length;
  }
}

let connections: FakeConnection[];

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  connections = [];
  __setConnectionFactory(() => {
    const conn = new FakeConnection();
    connections.push(conn);
    return conn;
  });
});

afterEach(() => {
  __resetSubscriberState();
  __setConnectionFactory(null);
  vi.unstubAllEnvs();
});

describe('shared redis subscriber', () => {
  it('uses ONE connection for any number of distinct topics', () => {
    const handles = Array.from({ length: 50 }, (_, i) =>
      acquireTopicSubscription(`chat:srv-1:ch-${i}`, () => undefined)
    );
    expect(connections).toHaveLength(1);
    expect(connections[0]!.subscribe).toHaveBeenCalledTimes(50);
    expect(connections[0]!.messageListenerCount).toBe(1);
    expect(__subscriberStats()).toMatchObject({ connections: 1, topics: 50, handlers: 50 });
    for (const h of handles) h.release();
  });

  it('SUBSCRIBEs once per topic and UNSUBSCRIBEs only after the last release', () => {
    const a = acquireTopicSubscription('chat:srv-1:ch-1', () => undefined);
    const b = acquireTopicSubscription('chat:srv-1:ch-1', () => undefined);
    const conn = connections[0]!;
    expect(conn.subscribe).toHaveBeenCalledTimes(1);
    expect(conn.subscribe).toHaveBeenCalledWith('lf:test:chat:srv-1:ch-1');

    a.release();
    a.release(); // idempotent
    expect(conn.unsubscribe).not.toHaveBeenCalled();
    b.release();
    expect(conn.unsubscribe).toHaveBeenCalledTimes(1);
    expect(conn.unsubscribe).toHaveBeenCalledWith('lf:test:chat:srv-1:ch-1');
    // The shared connection stays open for other topics.
    expect(conn.quit).not.toHaveBeenCalled();
    expect(__subscriberStats()).toMatchObject({ connections: 1, topics: 0 });
  });

  it('re-subscribes after a topic was fully released', () => {
    acquireTopicSubscription('presence:srv-1', () => undefined).release();
    acquireTopicSubscription('presence:srv-1', () => undefined);
    const conn = connections[0]!;
    expect(conn.subscribe).toHaveBeenCalledTimes(2);
    expect(conn.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('dispatches messages only to the handlers of the matching topic', () => {
    const onA = vi.fn();
    const onA2 = vi.fn();
    const onB = vi.fn();
    const a = acquireTopicSubscription('chat:srv-1:a', onA);
    acquireTopicSubscription('chat:srv-1:a', onA2);
    acquireTopicSubscription('chat:srv-1:b', onB);
    const conn = connections[0]!;

    conn.emitMessage('lf:test:chat:srv-1:a', '{"x":1}');
    expect(onA).toHaveBeenCalledWith('{"x":1}');
    expect(onA2).toHaveBeenCalledWith('{"x":1}');
    expect(onB).not.toHaveBeenCalled();

    a.release();
    conn.emitMessage('lf:test:chat:srv-1:a', '{"x":2}');
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onA2).toHaveBeenCalledTimes(2);
  });

  it('a throwing handler does not starve the others', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ok = vi.fn();
    acquireTopicSubscription('chat:srv-1:a', () => {
      throw new Error('boom');
    });
    acquireTopicSubscription('chat:srv-1:a', ok);
    connections[0]!.emitMessage('lf:test:chat:srv-1:a', 'raw');
    expect(ok).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('never opens a connection for an unparseable topic', () => {
    const handle = acquireTopicSubscription('bogus', () => undefined);
    handle.release();
    expect(connections).toHaveLength(0);
  });
});
