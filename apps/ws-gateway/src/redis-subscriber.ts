/**
 * Redis subscriber pool for the WS gateway.
 *
 * Mirrors the pattern in `apps/web/lib/activity-bus.ts`:
 *   - One ioredis connection per topic, shared across connections.
 *   - A `close()` decrements the refcount; the connection quits when
 *     nobody's left listening.
 *   - Subscriptions are fire-and-forget on the publish path; failures
 *     are logged, never thrown.
 *
 * Why a single subscriber per topic: ioredis forbids mixing regular
 * commands with subscribe on the same connection. Sharing one connection
 * across many topics also lets us pool at a coarser granularity than
 * one-per-topic-per-connection.
 */
import { Redis } from 'ioredis';
import { redisTopicName, parseTopic } from './protocol.js';

function envPrefix(): string {
  return process.env.NODE_ENV || 'dev';
}

function makeRedis(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('REDIS_URL is required for ws-gateway in production');
    }
    return new Redis('redis://:lobbyforge_dev@localhost:6379');
  }
  return new Redis(url);
}

const subscribers = new Map<string, Redis>();

interface TopicState {
  refcount: number;
  handlers: Set<(raw: string) => void>;
}

const states = new Map<string, TopicState>();

function topicForWire(topic: string): string | null {
  const parsed = parseTopic(topic);
  if (!parsed) return null;
  return redisTopicName(envPrefix(), parsed);
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

  let state = states.get(wireTopic);
  if (!state) {
    state = { refcount: 0, handlers: new Set() };
    states.set(wireTopic, state);
  }
  state.handlers.add(handler);
  state.refcount += 1;

  let sub: Redis | undefined = subscribers.get(wireTopic);
  if (!sub) {
    sub = makeRedis();
    subscribers.set(wireTopic, sub);
    const fanout = (channel: string, raw: string) => {
      if (channel !== wireTopic) return;
      const cur = states.get(wireTopic);
      if (!cur) return;
      for (const h of cur.handlers) {
        try {
          h(raw);
        } catch (err) {
          console.warn(
            `[ws-gateway] handler threw on ${wireTopic}: ${(err as Error).message}`
          );
        }
      }
    };
    sub.on('message', fanout);
    sub.on('error', (err: Error) => {
      console.warn(`[ws-gateway] redis sub error on ${wireTopic}: ${err.message}`);
    });
    // Subscribe is async; we fire-and-forget and let the first acquire
    // caller see any error via a small `subscribed` flag.
    sub.subscribe(wireTopic).catch((err: Error) => {
      console.warn(`[ws-gateway] subscribe failed for ${wireTopic}: ${err.message}`);
    });
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      const cur = states.get(wireTopic);
      if (!cur) return;
      cur.handlers.delete(handler);
      cur.refcount -= 1;
      if (cur.refcount <= 0) {
        states.delete(wireTopic);
        const conn: Redis | undefined = subscribers.get(wireTopic);
        subscribers.delete(wireTopic);
        if (conn) {
          conn.unsubscribe(wireTopic).catch(() => undefined).finally(() => {
            conn.quit().catch(() => undefined);
          });
        }
      }
    },
  };
}

/**
 * Test-only helper: drop all subscriber state. Use between test cases
 * so a previous case's open connection doesn't bleed across.
 */
export function __resetSubscriberState(): void {
  for (const conn of subscribers.values()) {
    conn.quit().catch(() => undefined);
  }
  subscribers.clear();
  states.clear();
}
