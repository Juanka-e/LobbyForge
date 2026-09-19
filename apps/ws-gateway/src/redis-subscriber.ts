/**
 * Redis subscriber for the WS gateway.
 *
 * beta-review (S6): ONE shared ioredis subscriber connection for the
 * whole process, multiplexed with SUBSCRIBE/UNSUBSCRIBE refcounting —
 * the same model `apps/web/lib/activity-bus.ts` uses (LF-029). The old
 * pool opened a NEW Redis connection per unique topic, so any member
 * could exhaust Redis `maxclients` by subscribing to many distinct
 * (even non-existent) topics.
 *
 *   - The first acquire of a topic sends SUBSCRIBE on the shared
 *     connection; later acquires only add a handler.
 *   - `release()` removes the handler; the last release sends
 *     UNSUBSCRIBE. The connection itself stays open for the process
 *     lifetime (ioredis reconnects + auto-resubscribes on its own).
 *   - Subscriptions are fire-and-forget: failures are logged, never
 *     thrown into the socket handler.
 *
 * ioredis forbids regular commands on a subscriber connection — this
 * connection only ever runs subscribe/unsubscribe/quit.
 */
import { Redis } from 'ioredis';
import { redisTopicName, parseTopic } from './protocol.js';

/** The slice of the ioredis client this module uses (test seam). */
export interface SubscriberConnection {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, raw: string) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  quit(): Promise<unknown>;
}

function envPrefix(): string {
  return process.env.NODE_ENV || 'dev';
}

function makeRedis(): SubscriberConnection {
  const url = process.env.REDIS_URL;
  if (!url) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('REDIS_URL is required for ws-gateway in production');
    }
    return new Redis('redis://:lobbyforge_dev@localhost:6379');
  }
  return new Redis(url);
}

let connectionFactory: () => SubscriberConnection = makeRedis;
let subscriber: SubscriberConnection | null = null;

/** One entry per acquire() — distinct even when the same fn is reused. */
interface HandlerEntry {
  fn: (raw: string) => void;
}

/** wire topic → live handler entries (size === refcount). */
const states = new Map<string, Set<HandlerEntry>>();

function topicForWire(topic: string): string | null {
  const parsed = parseTopic(topic);
  if (!parsed) return null;
  return redisTopicName(envPrefix(), parsed);
}

function getSubscriber(): SubscriberConnection {
  if (subscriber) return subscriber;
  const sub = connectionFactory();
  // ONE message listener for every topic — dispatch by channel name.
  sub.on('message', (channel: string, raw: string) => {
    const entries = states.get(channel);
    if (!entries) return;
    // Snapshot: a handler may release (mutate the set) while we iterate.
    for (const entry of [...entries]) {
      try {
        entry.fn(raw);
      } catch (err) {
        console.warn(`[ws-gateway] handler threw on ${channel}: ${(err as Error).message}`);
      }
    }
  });
  sub.on('error', (err: Error) => {
    // ioredis reconnects (and re-subscribes) on its own.
    console.warn(`[ws-gateway] redis subscriber error: ${err.message}`);
  });
  subscriber = sub;
  return sub;
}

export function acquireTopicSubscription(
  topic: string,
  handler: (raw: string) => void
): { release: () => void } {
  const wireTopic = topicForWire(topic);
  if (!wireTopic) {
    return {
      release: () => {
        /* noop — caller should never have subscribed to an unknown topic */
      },
    };
  }

  const sub = getSubscriber();
  let entries = states.get(wireTopic);
  if (!entries) {
    entries = new Set();
    states.set(wireTopic, entries);
    // First listener for this topic → SUBSCRIBE on the shared connection.
    sub.subscribe(wireTopic).catch((err: Error) => {
      console.warn(`[ws-gateway] subscribe failed for ${wireTopic}: ${err.message}`);
    });
  }
  const entry: HandlerEntry = { fn: handler };
  entries.add(entry);

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      const cur = states.get(wireTopic);
      if (!cur) return;
      cur.delete(entry);
      if (cur.size === 0) {
        states.delete(wireTopic);
        // Last listener gone → UNSUBSCRIBE; the connection stays open.
        // Commands are pipelined in order, so an immediate re-acquire's
        // SUBSCRIBE lands after this UNSUBSCRIBE.
        subscriber?.unsubscribe(wireTopic).catch(() => undefined);
      }
    },
  };
}

/** Close the shared connection (gateway shutdown). Idempotent. */
export function shutdownSubscriber(): void {
  const sub = subscriber;
  subscriber = null;
  states.clear();
  if (sub) sub.quit().catch(() => undefined);
}

/** Introspection for tests / health: live topic + connection counts. */
export function __subscriberStats(): { connections: number; topics: number; handlers: number } {
  let handlers = 0;
  for (const entries of states.values()) handlers += entries.size;
  return { connections: subscriber ? 1 : 0, topics: states.size, handlers };
}

/** Test-only: swap the Redis connection factory (no real Redis). */
export function __setConnectionFactory(factory: (() => SubscriberConnection) | null): void {
  connectionFactory = factory ?? makeRedis;
}

/**
 * Test-only helper: drop all subscriber state. Use between test cases
 * so a previous case's open connection doesn't bleed across.
 */
export function __resetSubscriberState(): void {
  shutdownSubscriber();
}
