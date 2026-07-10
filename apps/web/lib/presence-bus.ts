/**
 * Presence bus — Redis pub/sub for real-time member status updates.
 *
 * Mirrors the chat-bus + activity-bus pattern. The presence POST route
 * calls `publishPresenceChange(...)` after writing to Redis; the WS
 * gateway forwards the event to every client subscribed to
 * `presence:{serverId}`.
 *
 * Topic shape: `lf:{env}:presence:{serverId}`.
 *
 * The payload is the user's new presence snapshot (userId, status,
 * channelId, lastSeen). Clients receiving the event update their local
 * member list — add the user if new, update status if existing, mark
 * offline if the TTL has expired (detected client-side via lastSeen
 * staleness check).
 */
import { redis as sharedRedis } from './redis';

function envPrefix(): string {
  return process.env.NODE_ENV || 'dev';
}

function topicName(serverId: string): string {
  return `lf:${envPrefix()}:presence:${serverId}`;
}

export interface PresenceChangeEvent {
  type: 'presence-update';
  userId: string;
  status: string;
  channelId: string;
  lastSeen: number;
  activity?: { kind: string; label: string; pluginId?: string; serverName?: string };
}

/**
 * Publish a presence change to the server-wide topic. Fire-and-forget —
 * a Redis blip never fails the presence POST.
 */
export function publishPresenceChange(input: {
  serverId: string;
  event: PresenceChangeEvent;
}): void {
  const payload = JSON.stringify(input.event);
  sharedRedis
    .publish(topicName(input.serverId), payload)
    .catch((err) => {
      console.warn(
        `[presence-bus] publish failed for ${input.serverId}: ${(err as Error).message}`
      );
    });
}
