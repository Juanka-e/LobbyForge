/**
 * Chat message bus — Redis pub/sub for new chat messages.
 *
 * Mirrors the activity-state bus in `activity-bus.ts`: the messages
 * POST route calls `publishChatMessage(...)` after persisting a row;
 * the WS gateway (and any future realtime consumer) subscribes via
 * `subscribeChatMessages(...)`.
 *
 * Topic shape: `lf:{env}:chat:{serverId}:{channelId}`. Each message
 * is a JSON blob with the persisted row + a server timestamp.
 *
 * Multi-instance safe: every Next.js worker + every ws-gateway pod
 * talks to the same Redis instance, so any worker's message broadcast
 * reaches every other worker's open subscriptions.
 *
 * Resilience: the publish call is fire-and-forget — a transient Redis
 * outage does NOT fail the messages POST route.
 */
import Redis from 'ioredis';
import { redis as sharedRedis } from './redis';

function envPrefix(): string {
  return process.env.NODE_ENV || 'dev';
}

function topicName(serverId: string, channelId: string): string {
  return `lf:${envPrefix()}:chat:${serverId}:${channelId}`;
}

const subscribers = new Map<string, Redis>();

interface TopicState {
  refcount: number;
  handlers: Set<(channel: string, raw: string) => void>;
}

const states = new Map<string, TopicState>();

export interface ChatMessagePayload {
  id: string;
  channelId: string;
  userId: string;
  content: string;
  metadata: Record<string, unknown> | null;
  replyToId: string | null;
  createdAt: string;
}

interface ChatMessageEnvelope {
  type: 'message';
  message: ChatMessagePayload;
  at: string;
}

/**
 * Publish a new chat message. Returns immediately. Errors are logged
 * but never thrown — the messages POST route's caller still gets a 201.
 */
export function publishChatMessage(input: {
  serverId: string;
  channelId: string;
  message: ChatMessagePayload;
}): void {
  const payload: ChatMessageEnvelope = {
    type: 'message',
    message: input.message,
    at: new Date().toISOString(),
  };
  sharedRedis
    .publish(topicName(input.serverId, input.channelId), JSON.stringify(payload))
    .catch((err) => {
      console.warn(
        `[chat-bus] publish failed for ${input.channelId}: ${(err as Error).message}`
      );
    });
}

/**
 * Subscribe to a single channel's message stream. The returned
 * `close()` function unsubscribes and tears down the Redis listener.
 * The Redis subscriber connection is shared across all callers for
 * a given topic; `close()` quits the connection when nobody's left.
 */
export function subscribeChatMessages(
  serverId: string,
  channelId: string,
  onMessage: (msg: ChatMessageEnvelope) => void,
  onError?: (err: Error) => void
): { close: () => void } {
  const topic = topicName(serverId, channelId);

  let state = states.get(topic);
  if (!state) {
    state = { refcount: 0, handlers: new Set() };
    states.set(topic, state);
  }

  let sub = subscribers.get(topic);
  let isNew = false;
  if (!sub) {
    sub = sharedRedis.duplicate();
    subscribers.set(topic, sub);
    isNew = true;
  }

  const handler = (channel: string, raw: string) => {
    if (channel !== topic) return;
    try {
      const parsed = JSON.parse(raw) as ChatMessageEnvelope;
      onMessage(parsed);
    } catch (err) {
      console.warn(`[chat-bus] bad message on ${topic}: ${(err as Error).message}`);
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
