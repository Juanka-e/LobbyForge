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
 * 10th-audit: SSE streams also listen for invalidation events — the
 * 30s keepalive recheck alone leaves a kick a up-to-30s event window.
 * The web app shares the bus channel with the ws-gateway; handlers
 * filter for their own blast radius. Returns an unsubscribe.
 */
export function subscribeAccessInvalidation(
  onEvent: (event: AccessInvalidationEvent) => void
): () => void {
  const io = redis as unknown as {
    duplicate: () => {
      subscribe: (ch: string) => Promise<unknown>;
      on: (ev: string, cb: (ch: string, raw: string) => void) => void;
      quit: () => Promise<unknown>;
    };
  };
  let sub: ReturnType<typeof io.duplicate> | null = null;
  void (async () => {
    try {
      sub = io.duplicate();
      sub.on('message', (_channel: string, raw: string) => {
        try {
          onEvent(JSON.parse(raw) as AccessInvalidationEvent);
        } catch {
          /* publisher owns the shape */
        }
      });
      await sub.subscribe(ACCESS_INVALIDATION_CHANNEL);
    } catch (err) {
      console.error('[access-invalidation] subscribe failed:', (err as Error).message);
    }
  })();
  return () => {
    void sub?.quit().catch(() => undefined);
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
