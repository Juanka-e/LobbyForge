/**
 * Access-invalidation bus (LF-SEC-003).
 *
 * WebSocket subscriptions are authorized at SUBSCRIBE time; when access
 * state later changes (kick/ban/role loss/channel policy/block), REST
 * immediately rejects the user but an already-open subscription kept
 * receiving events. Mutation routes now publish an invalidation event
 * on this Redis channel and the ws-gateway re-runs its authorization
 * for the affected live subscriptions (removing them + notifying the
 * client with `access_revoked`).
 *
 * Event-driven invalidation is the PRIMARY mechanism — the gateway does
 * not query Postgres per chat event.
 */
import { redis } from './redis';

export const ACCESS_INVALIDATION_CHANNEL = 'lf:access-invalidation';

export type AccessInvalidationEvent =
  | {
      /** The user's access to an entire server changed (kick/ban/roles). */
      kind: 'user-server-access';
      serverId: string;
      userId: string;
      reason: 'kick' | 'ban' | 'roles_changed';
    }
  | {
      /** A single channel's visibility policy changed. */
      kind: 'channel-policy';
      serverId: string;
      channelId: string;
      reason: 'permissions_changed';
    }
  | {
      /** Server-wide policy changed (role permission edits) — revalidate
       * every subscription in this server. Rare + expensive + correct. */
      kind: 'server-policy';
      serverId: string;
      reason: 'roles_permissions_changed';
    }
  | {
      /** A DM pair's communication state changed (block/unblock). */
      kind: 'dm-access';
      channelId: string;
      reason: 'blocked' | 'unblocked';
    };

/**
 * 10th-audit + 11th-audit: SSE streams listen for invalidation events —
 * the 30s keepalive recheck alone leaves a kick a up-to-30s event
 * window. ONE process-wide subscriber connection multiplexes every
 * registered handler (the per-stream duplicate() the first cut used
 * re-introduced exactly the connection-exhaustion surface the activity
 * bus had already solved: 1 SSE ≈ 1 extra Redis subscriber, hordable
 * for hours). Handlers filter for their own blast radius; registering
 * costs a Set entry, not a connection.
 */
type InvalidationHandler = (event: AccessInvalidationEvent) => void;
const invalidationHandlers = new Set<InvalidationHandler>();
type SubscriberConnection = {
  subscribe: (ch: string) => Promise<unknown>;
  quit: () => Promise<unknown>;
};
let invalidationSubscriber: SubscriberConnection | null = null;
// 18th-audit: SINGLETON PROMISE — the old starting-flag flipped false
// in a finally block BEFORE the subscribe() promise settled, so burst
// SSE openings each saw (null, false) and created duplicate Redis
// subscribers (leaked connections, duplicate fan-out). The promise
// guarantees exactly one duplicate() per process regardless of timing.
let invalidationSubscriberPromise: Promise<SubscriberConnection> | null = null;

let invalidationRetryMs = 500;
const INVALIDATION_RETRY_MAX_MS = 30_000;

function fanOut(raw: string): void {
  let event: AccessInvalidationEvent;
  try {
    event = JSON.parse(raw) as AccessInvalidationEvent;
  } catch {
    return; // publisher owns the shape
  }
  for (const handler of invalidationHandlers) {
    try {
      handler(event);
    } catch {
      /* one stream's handler must not break the fan-out */
    }
  }
}

function ensureInvalidationSubscriber(): Promise<SubscriberConnection> {
  if (invalidationSubscriber) return Promise.resolve(invalidationSubscriber);
  if (invalidationSubscriberPromise) return invalidationSubscriberPromise;
  const io = redis as unknown as {
    duplicate: () => SubscriberConnection & {
      on: (ev: string, cb: (ch: string, raw: string) => void) => void;
    };
  };
  invalidationSubscriberPromise = (async () => {
    const sub = io.duplicate();
    sub.on('message', (_channel: string, raw: string) => fanOut(raw));
    try {
      await sub.subscribe(ACCESS_INVALIDATION_CHANNEL);
      invalidationRetryMs = 500;
      invalidationSubscriber = sub;
      return sub;
    } catch (err) {
      console.error(
        `[access-invalidation] subscribe failed (retry in ${invalidationRetryMs}ms):`,
        (err as Error).message
      );
      void sub.quit().catch(() => undefined);
      // Reset so the NEXT registration retries; backoff between tries.
      invalidationSubscriberPromise = null;
      setTimeout(() => {
        invalidationSubscriberPromise = null;
      }, invalidationRetryMs);
      invalidationRetryMs = Math.min(invalidationRetryMs * 2, INVALIDATION_RETRY_MAX_MS);
      throw err;
    }
  })();
  return invalidationSubscriberPromise;
}

/** Register a handler on the SHARED subscriber; returns an unregister. */
export function subscribeAccessInvalidation(
  onEvent: InvalidationHandler
): () => void {
  void ensureInvalidationSubscriber().catch(() => {
    /* backoff retry scheduled inside ensure */
  });
  invalidationHandlers.add(onEvent);
  return () => {
    invalidationHandlers.delete(onEvent);
    // The singleton connection intentionally stays up — other streams
    // (now or later) share it.
  };
}

/** Fire-and-forget publish; never blocks the mutating request. */
export function publishAccessInvalidation(event: AccessInvalidationEvent): void {
  redis
    .publish(ACCESS_INVALIDATION_CHANNEL, JSON.stringify(event))
    .catch((err) =>
      console.error('[access-invalidation] publish failed:', (err as Error).message)
    );
}
