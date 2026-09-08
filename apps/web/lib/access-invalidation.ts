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

/** Fire-and-forget publish; never blocks the mutating request. */
export function publishAccessInvalidation(event: AccessInvalidationEvent): void {
  redis
    .publish(ACCESS_INVALIDATION_CHANNEL, JSON.stringify(event))
    .catch((err) =>
      console.error('[access-invalidation] publish failed:', (err as Error).message)
    );
}
