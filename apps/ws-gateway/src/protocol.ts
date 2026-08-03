/**
 * Wire protocol for the LobbyForge WS gateway.
 *
 * Browser clients open a single WebSocket per session and use the message
 * types below to multiplex subscriptions to multiple Redis-backed
 * channels. The gateway validates the guest cookie on upgrade, then
 * translates `subscribe` / `unsubscribe` calls into Redis pub/sub
 * subscriptions.
 *
 * Topic shape:
 *   activity-state:{serverId}:{sessionId}
 *   chat:{serverId}:{channelId}
 *   presence:{serverId}
 *
 * Topic authorization is enforced per-subscribe against the user's
 * server membership — see `authorize.ts`. Subscribing to a topic you
 * aren't authorized for yields `{type:'error', topic, code:'forbidden'}`.
 */
import { z } from 'zod';

export type Topic =
  | `activity-state:${string}:${string}`
  | `chat:${string}:${string}`
  | `presence:${string}`
  | `dm:${string}`;

export const SubscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  topic: z.string().min(1).max(512),
});

export const UnsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  topic: z.string().min(1).max(512),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
]);

export type SubscribeMessage = z.infer<typeof SubscribeMessageSchema>;
export type UnsubscribeMessage = z.infer<typeof UnsubscribeMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export interface SubscribedMessage {
  type: 'subscribed';
  topic: string;
  at: string;
}

export interface UnsubscribedMessage {
  type: 'unsubscribed';
  topic: string;
  at: string;
}

export interface HelloMessage {
  type: 'hello';
  ok: true;
  uid: string;
  at: string;
}

export interface EventMessage {
  type: 'event';
  topic: string;
  data: unknown;
  at: string;
}

export interface ErrorMessage {
  type: 'error';
  topic?: string;
  code: 'bad_message' | 'forbidden' | 'unknown_topic' | 'rate_limited';
  message: string;
}

export type ServerMessage =
  | HelloMessage
  | SubscribedMessage
  | UnsubscribedMessage
  | EventMessage
  | ErrorMessage;

/**
 * Parse a topic into its parts. Returns `null` if the topic isn't one
 * of the supported shapes — callers should reject unknown topics.
 *
 * Presence topics are 2-part (`presence:{serverId}`); the other kinds
 * are 3-part (`kind:{serverId}:{resourceId}`). The parser handles both.
 */
export function parseTopic(topic: string): {
  kind: 'activity-state' | 'chat' | 'presence' | 'dm';
  serverId: string;
  resourceId: string;
} | null {
  const parts = topic.split(':');
  const kind = parts[0];

  // presence:{serverId} — 2 parts
  if (kind === 'presence') {
    if (parts.length !== 2 || !parts[1]) return null;
    return { kind: 'presence', serverId: parts[1], resourceId: parts[1] };
  }

  // dm:{channelId} — 2 parts (DM channels are instance-local, no serverId)
  if (kind === 'dm') {
    if (parts.length !== 2 || !parts[1]) return null;
    return { kind: 'dm', serverId: parts[1], resourceId: parts[1] };
  }

  // activity-state / chat — 3 parts
  if (parts.length !== 3) return null;
  const [, serverId, resourceId] = parts;
  if (kind !== 'activity-state' && kind !== 'chat') return null;
  if (!serverId || !resourceId) return null;
  return { kind, serverId, resourceId };
}

/**
 * Build the Redis topic name for a parsed topic. Topic naming is the
 * gateway's internal contract — keep it identical to the publisher
 * (`apps/web/lib/{activity-bus,chat-bus,presence-bus}.ts`).
 */
export function redisTopicName(envPrefix: string, parsed: NonNullable<ReturnType<typeof parseTopic>>): string {
  if (parsed.kind === 'presence') {
    return `lf:${envPrefix}:presence:${parsed.serverId}`;
  }
  if (parsed.kind === 'dm') {
    return `lf:${envPrefix}:dm:${parsed.resourceId}`;
  }
  return `lf:${envPrefix}:${parsed.kind}:${parsed.serverId}:${parsed.resourceId}`;
}