/**
 * Activity state bus — Redis pub/sub for activity state changes.
 *
 * The action route calls `publishActivityStateChange(...)` after
 * persisting a new state. The SSE route at
 * `/api/servers/{id}/activities/{sessionId}/stream` subscribes to
 * the same channel and forwards events to the browser.
 *
 * Topic shape: `lf:{env}:activity-state:{serverId}:{sessionId}`.
 * Each message is a JSON blob with `{ status, state, at }`.
 *
 * Multi-instance safe: every Next.js worker talks to the same
 * Redis instance, so any worker's action broadcast reaches every
 * other worker's open SSE subscriptions.
 *
 * Resilience: the publish call is fire-and-forget — a transient
 * Redis outage does NOT fail the action route. The SSE route
 * catches its own connection errors and the browser falls back to
 * polling. The polling fallback is `POLL_FALLBACK_MS` below.
 */
import Redis from 'ioredis';
import { redis as sharedRedis } from './redis';

function envPrefix(): string {
  return process.env.NODE_ENV || 'dev';
}

function topicName(serverId: string, sessionId: string): string {
  return `lf:${envPrefix()}:activity-state:${serverId}:${sessionId}`;
}

/**
 * A single subscriber connection is shared per-process; creating one
 * per SSE stream would exhaust Redis connections as soon as a popular
 * voice room filled up.
 */
const subscribers = new Map<string, Redis>();

interface TopicState {
  refcount: number;
  handlers: Set<(channel: string, raw: string) => void>;
}

const states = new Map<string, TopicState>();

interface ActivityStateMessage {
  status: string;
  state: Record<string, unknown>;
  publicSummary?: Record<string, unknown>;
  at: string;
}

/**
 * Publish a state change. Returns immediately. Errors are logged
 * but never thrown — the action route's caller still gets a 200.
 */
export function publishActivityStateChange(input: {
  serverId: string;
  sessionId: string;
  status: string;
  state: Record<string, unknown>;
  publicSummary?: Record<string, unknown>;
}): void {
  const payload: ActivityStateMessage = {
    status: input.status,
    state: input.state,
    publicSummary: input.publicSummary,
    at: new Date().toISOString(),
  };
  // Fire and forget — never await on the action path.
  sharedRedis
    .publish(topicName(input.serverId, input.sessionId), JSON.stringify(payload))
    .catch((err) => {
      console.warn(
        `[activity-bus] publish failed for ${input.sessionId}: ${(err as Error).message}`
      );
    });
}

/**
 * Subscribe to a single session's state stream. Calls `onMessage`
 * for each published message. The returned `close()` function
 * unsubscribes and tears down the Redis listener — call it when
 * the SSE stream closes.
 *
 * The Redis subscriber connection is shared across all callers for
 * a given topic; `close()` decrements the refcount and only quits
 * the connection when nobody's left listening.
 */
export function subscribeActivityStateChange(
  serverId: string,
  sessionId: string,
  onMessage: (msg: ActivityStateMessage) => void,
  onError?: (err: Error) => void
): { close: () => void } {
  const topic = topicName(serverId, sessionId);

  let state = states.get(topic);
  if (!state) {
    state = { refcount: 0, handlers: new Set() };
    states.set(topic, state);
  }

  let sub = subscribers.get(topic);
  let isNew = false;
  if (!sub) {
    // Dedicated connection for subscribe — ioredis forbids mixing
    // regular commands with subscribe on the same connection.
    sub = sharedRedis.duplicate();
    subscribers.set(topic, sub);
    isNew = true;
  }

  const handler = (channel: string, raw: string) => {
    if (channel !== topic) return;
    try {
      const parsed = JSON.parse(raw) as ActivityStateMessage;
      onMessage(parsed);
    } catch (err) {
      // A bad message shouldn't kill the stream — drop it.
      console.warn(`[activity-bus] bad message on ${topic}: ${(err as Error).message}`);
    }
  };
  state.handlers.add(handler);
  state.refcount += 1;

  let subscribed = false;
  let closed = false;
  const attach = async () => {
    if (!sub) return;
    sub.on('message', handler);
    if (isNew) {
      sub.on('error', (err) => onError?.(err));
      try {
        await sub.subscribe(topic);
        subscribed = true;
      } catch (err) {
        onError?.(err as Error);
      }
    } else {
      subscribed = true;
    }
  };

  void attach();

  return {
    close: () => {
      if (closed) return;
      closed = true;
      sub?.off('message', handler);
      const cur = states.get(topic);
      if (!cur) return;
      cur.handlers.delete(handler);
      cur.refcount -= 1;
      if (cur.refcount <= 0) {
        states.delete(topic);
        const conn = subscribers.get(topic);
        subscribers.delete(topic);
        if (conn && subscribed) {
          conn
            .unsubscribe(topic)
            .catch(() => {})
            .finally(() => {
              conn.quit().catch(() => undefined);
            });
        } else if (conn) {
          conn.quit().catch(() => undefined);
        }
      }
    },
  };
}

export const POLL_FALLBACK_MS = 5_000;
