/**
 * Access-invalidation consumer (LF-SEC-003).
 *
 * Subscribes to the same Redis channel the web app's mutation routes
 * publish on (`lf:access-invalidation`). On every event the gateway
 * re-runs authorizeTopicSubscribe for the AFFECTED live subscriptions
 * and removes any that no longer pass, notifying the client with an
 * `access_revoked` message so the UI can drop the resource
 * immediately.
 *
 * This is the event-driven PRIMARY invalidation path — the gateway does
 * not re-query Postgres per chat event.
 */
import type { Redis } from 'ioredis';
import { parseTopic } from './protocol.js';

export const ACCESS_INVALIDATION_CHANNEL = 'lf:access-invalidation';

export interface AccessInvalidationEvent {
  kind: 'user-server-access' | 'channel-policy' | 'server-policy' | 'dm-access';
  serverId?: string;
  channelId?: string;
  userId?: string;
  reason: string;
}

export type InvalidationHandler = (event: AccessInvalidationEvent) => void;

let subscriber: Redis | null = null;

/** Start listening (idempotent). Returns a stop() for tests/shutdown. */
export function initAccessInvalidationListener(onEvent: InvalidationHandler): () => void {
  void (async () => {
    if (subscriber) return;
    try {
      const RedisMod = await import('ioredis');
      const RedisCtor = ('default' in RedisMod ? RedisMod.default : RedisMod) as unknown as new (
        url: string
      ) => Redis;
      const sub = new RedisCtor(process.env.REDIS_URL || 'redis://:lobbyforge_dev@localhost:6379');
      sub.on('error', (err: Error) => {
        // ioredis reconnects on its own — never give up permanently
        // (LF-SEC-009 lesson: one blip must not disable a security path).
        console.warn('[access-invalidation] subscriber error:', err.message);
      });
      await sub.subscribe(ACCESS_INVALIDATION_CHANNEL);
      sub.on('message', (_channel: string, raw: string) => {
        try {
          const event = JSON.parse(raw) as AccessInvalidationEvent;
          onEvent(event);
        } catch {
          /* malformed payload — publisher side owns the shape */
        }
      });
      subscriber = sub;
    } catch (err) {
      console.warn('[access-invalidation] failed to start subscriber:', (err as Error).message);
    }
  })();

  return () => {
    const sub = subscriber;
    subscriber = null;
    if (sub) void sub.quit().catch(() => undefined);
  };
}

/** Reset module state — tests only. */
export function __resetAccessInvalidation(): void {
  const sub = subscriber;
  subscriber = null;
  if (sub) void sub.quit().catch(() => undefined);
}

/**
 * Does this topic fall inside the event's blast radius? Pure — unit
 * tested without Redis.
 */
export function topicMatchesInvalidation(
  topic: string,
  event: AccessInvalidationEvent
): boolean {
  const parsed = parseTopic(topic);
  if (!parsed) return false;

  switch (event.kind) {
    case 'user-server-access':
      // The named user's access to one server changed — every topic of
      // that server (chat/activity/presence) must be re-checked.
      return parsed.kind !== 'dm' && parsed.serverId === event.serverId;
    case 'channel-policy':
      return (
        parsed.kind !== 'dm' &&
        parsed.serverId === event.serverId &&
        parsed.resourceId === event.channelId
      );
    case 'server-policy':
      // A role's permissions/positions changed — revalidate EVERYTHING
      // in that server (rare, coarse, correct).
      return parsed.kind !== 'dm' && parsed.serverId === event.serverId;
    case 'dm-access':
      return parsed.kind === 'dm' && parsed.resourceId === event.channelId;
    default:
      return false;
  }
}
