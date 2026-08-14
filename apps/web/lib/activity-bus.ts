/**
 * Activity state bus — Redis pub/sub for activity state changes.
 *
 * LF-029: The subscriber side uses a SINGLE shared Redis connection with
 * channel multiplexing (SUBSCRIBE/UNSUBSCRIBE per topic on one client),
 * instead of one connection per topic. With 100 concurrent activity
 * sessions the old model opened 100 Redis connections; this model opens 1.
 *
 * Topic shape: `lf:{env}:activity-state:{serverId}:{sessionId}`.
 * Each message is a JSON blob with `{ status, state, at }`.
 *
 * Resilience: the publish call is fire-and-forget — a transient
 * Redis outage does NOT fail the action route. The SSE route
 * catches its own connection errors and the browser falls back to
 * polling. The polling fallback is `POLL_FALLBACK_MS` below.
 */
import type Redis from 'ioredis';
import { redis as sharedRedis } from './redis';

function envPrefix(): string {
  return process.env.NODE_ENV || 'dev';
}

function topicName(serverId: string, sessionId: string): string {
  return `lf:${envPrefix()}:activity-state:${serverId}:${sessionId}`;
}

// ── Single multiplexed subscriber ────────────────────────────────────
// One Redis connection handles ALL topic subscriptions. ioredis forbids
// mixing regular commands with SUBSCRIBE on the same connection — this
// dedicated subscriber only ever calls subscribe/unsubscribe/quit.

let subscriber: Redis | null = null;
let subscriberConnecting: Promise<Redis> | null = null;

interface TopicState {
  refcount: number;
  handlers: Set<(msg: ActivityStateMessage) => void>;
}

const states = new Map<string, TopicState>();

async function getSubscriber(): Promise<Redis> {
  if (subscriber && subscriber.status === 'ready') return subscriber;
  if (subscriberConnecting) return subscriberConnecting;

  subscriberConnecting = new Promise<Redis>((resolve, reject) => {
    const sub = sharedRedis.duplicate();
    const onReady = () => {
      cleanup();
      subscriber = sub;
      resolve(sub);
    };
    const onError = (err: Error) => {
      cleanup();
      sub.disconnect();
      reject(err);
    };
    const cleanup = () => {
      sub.removeListener('ready', onReady);
      sub.removeListener('error', onError);
    };
    sub.once('ready', onReady);
    sub.once('error', onError);
  });

  try {
    return await subscriberConnecting;
  } finally {
    subscriberConnecting = null;
  }
}

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
 * unsubscribes — the shared connection stays open for other topics;
 * it is never quit (it lives for the process lifetime).
 */
export async function subscribeActivityStateChange(
  serverId: string,
  sessionId: string,
  onMessage: (msg: ActivityStateMessage) => void,
  onError?: (err: Error) => void
): Promise<{ close: () => void }> {
  const topic = topicName(serverId, sessionId);

  let state = states.get(topic);
  if (!state) {
    state = { refcount: 0, handlers: new Set() };
    states.set(topic, state);
  }

  // First listener for this topic → SUBSCRIBE on the shared connection.
  if (state.refcount === 0) {
    try {
      const sub = await getSubscriber();
      // Route incoming messages to this topic's handlers.
      // (One listener per connection — added once, never removed.)
      if (!sub.listenerCount('message')) {
        sub.on('message', (channel: string, raw: string) => {
          const topicState = states.get(channel);
          if (!topicState) return;
          let parsed: ActivityStateMessage;
          try {
            parsed = JSON.parse(raw) as ActivityStateMessage;
          } catch {
            console.warn(`[activity-bus] bad message on ${channel}`);
            return;
          }
          for (const handler of topicState.handlers) {
            try {
              handler(parsed);
            } catch {
              // one handler failing shouldn't kill others
            }
          }
        });
      }
      await sub.subscribe(topic);
    } catch (err) {
      states.delete(topic);
      onError?.(err as Error);
      // Return a no-op close — subscription failed.
      return { close: () => undefined };
    }
  }

  state.handlers.add(onMessage);
  state.refcount += 1;

  let closed = false;
  return {
    close: () => {
      if (closed) return;
      closed = true;
      const cur = states.get(topic);
      if (!cur) return;
      cur.handlers.delete(onMessage);
      cur.refcount -= 1;
      if (cur.refcount <= 0) {
        states.delete(topic);
        // UNSUBSCRIBE on the shared connection — connection stays open.
        if (subscriber && subscriber.status === 'ready') {
          subscriber.unsubscribe(topic).catch(() => undefined);
        }
      }
    },
  };
}

export const POLL_FALLBACK_MS = 5_000;
