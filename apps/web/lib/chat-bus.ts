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
  /** null for a bot-authored message — see `bot`. */
  userId: string | null;
  /** Set when a bot wrote the message (Bot API or a built-in bot). */
  botId?: string | null;
  bot?: { id: string; name: string; type: string } | null;
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
 * Bot API v2 §4.2: edits and deletes travel on the same channel topic so
 * the gateway can give bots `message_update` / `message_delete`. The
 * envelopes carry only ids — the gateway reloads an edited message itself
 * (and checks the bot's access) instead of trusting a payload, and a
 * deleted message has nothing left to send. `botId` is the AUTHOR bot, so
 * a bot never hears about its own messages. Browser consumers only act on
 * `type: 'message'` and ignore these.
 */
interface ChatMessageUpdateEnvelope {
  type: 'message_update';
  message: { id: string; botId?: string };
  at: string;
}

interface ChatMessageDeleteEnvelope {
  type: 'message_delete';
  id: string;
  botId?: string;
  at: string;
}

function publishEnvelope(serverId: string, channelId: string, payload: unknown): void {
  sharedRedis.publish(topicName(serverId, channelId), JSON.stringify(payload)).catch((err) => {
    console.warn(`[chat-bus] publish failed for ${channelId}: ${(err as Error).message}`);
  });
}

/** A message's text changed. Fire-and-forget, like `publishChatMessage`. */
export function publishChatMessageUpdate(input: {
  serverId: string;
  channelId: string;
  messageId: string;
  botId?: string | null;
}): void {
  const payload: ChatMessageUpdateEnvelope = {
    type: 'message_update',
    message: { id: input.messageId, ...(input.botId ? { botId: input.botId } : {}) },
    at: new Date().toISOString(),
  };
  publishEnvelope(input.serverId, input.channelId, payload);
}

/** A message was deleted. Fire-and-forget. */
export function publishChatMessageDelete(input: {
  serverId: string;
  channelId: string;
  messageId: string;
  botId?: string | null;
}): void {
  const payload: ChatMessageDeleteEnvelope = {
    type: 'message_delete',
    id: input.messageId,
    ...(input.botId ? { botId: input.botId } : {}),
    at: new Date().toISOString(),
  };
  publishEnvelope(input.serverId, input.channelId, payload);
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
