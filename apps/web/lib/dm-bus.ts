/**
 * DM bus — Redis pub/sub for real-time direct message delivery.
 *
 * Mirrors the chat-bus + presence-bus pattern. The DM message POST route
 * calls `publishDmMessage(...)` after persisting; the DmView client polls
 * /api/dm/{id}/messages as a fallback. Full WS-gateway fanout (so a second
 * browser sees the message instantly) lands when the gateway gains a `dm`
 * topic kind — the publisher shape is forward-compatible with that.
 *
 * Topic shape: `lf:{env}:dm:{channelId}`.
 */
import { redis as sharedRedis } from './redis';

function envPrefix(): string {
  return process.env.NODE_ENV || 'dev';
}

function topicName(channelId: string): string {
  return `lf:${envPrefix()}:dm:${channelId}`;
}

export interface DmMessageEvent {
  id: string;
  dmChannelId: string;
  authorId: string;
  content: string;
  createdAt: string;
}

/**
 * Publish a DM message event. Fire-and-forget — a Redis blip never fails
 * the message POST (the row is already persisted).
 */
export function publishDmMessage(input: {
  channelId: string;
  message: DmMessageEvent;
}): void {
  const payload = JSON.stringify(input.message);
  sharedRedis
    .publish(topicName(input.channelId), payload)
    .catch((err) => {
      console.warn(
        `[dm-bus] publish failed for ${input.channelId}: ${(err as Error).message}`
      );
    });
}
