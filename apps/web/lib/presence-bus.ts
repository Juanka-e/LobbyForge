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
 * beta-review (S5): the payload is a CONTENT-FREE "presence changed —
 * re-fetch" signal: `{ type: 'presence-update' }`. It used to carry the
 * raw snapshot (userId, status, voice channelId, activity incl.
 * serverName) to EVERY member, bypassing the per-viewer privacy
 * settings, block list and channel visibility that `GET /api/presence`
 * applies. Clients now re-fetch the REST snapshot, so the realtime path
 * can never reveal more than REST. (The gateway strips payloads too —
 * defence in depth against an older publisher.)
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
}

/**
 * Publish a presence change to the server-wide topic. Fire-and-forget —
 * a Redis blip never fails the presence POST. Only the server id is
 * accepted: nothing about WHO changed or HOW reaches the bus.
 */
export function publishPresenceChange(input: { serverId: string }): void {
  const event: PresenceChangeEvent = { type: 'presence-update' };
  const payload = JSON.stringify(event);
  sharedRedis
    .publish(topicName(input.serverId), payload)
    .catch((err) => {
      console.warn(
        `[presence-bus] publish failed for ${input.serverId}: ${(err as Error).message}`
      );
    });
}
