/**
 * Can a bot receive a slash-command interaction right now?
 * (docs/BOT_API_V2.md §3.3, `bot_offline`)
 *
 * An interaction reaches a bot in one of two ways, both behind
 * `receive_events`:
 *  - its EVENT STREAM: the gateway subscribes to the Redis channel
 *    `lf:{env}:bot-events:{botId}` when a bot connection becomes ready and
 *    unsubscribes when the last one closes (apps/ws-gateway/src/
 *    bot-gateway.ts), so `PUBSUB NUMSUB` on that channel counts the
 *    gateways holding a live connection for the bot — no extra registry;
 *  - its HTTP EVENT ENDPOINT, when one is enabled and subscribed to
 *    `interaction_create` (it is called whether or not the bot's process
 *    is up, so it keeps the old behaviour: 202 and wait).
 *
 * Neither → the invoke route answers 409 `bot_offline` at once instead of
 * a "thinking…" row that times out 15 minutes later. When Redis cannot be
 * asked, the answer is "reachable" (fail open: the old behaviour).
 */
import { getBotEventEndpoint, type BotRow } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { botEventsChannel } from './events';
import { botHasPermission } from './permissions';

let redisModule: Promise<typeof import('@/lib/redis')> | null = null;

/** Live event-stream connections for the bot (gateway subscribers), or null when Redis cannot say. */
export async function liveBotStreamCount(botId: string): Promise<number | null> {
  try {
    redisModule ??= import('@/lib/redis');
    const { redis } = await redisModule;
    const reply = (await redis.pubsub('NUMSUB', botEventsChannel(botId))) as unknown[];
    const count = Number(reply?.[1]);
    return Number.isFinite(count) ? count : null;
  } catch (err) {
    console.warn('[bots] stream presence unavailable:', (err as Error).message);
    return null;
  }
}

export async function botCanReceiveInteractions(bot: Pick<BotRow, 'id' | 'permissions'>): Promise<boolean> {
  // Without receive_events neither the stream nor the endpoint delivers.
  if (!botHasPermission(bot, 'receive_events')) return false;
  const endpoint = await getBotEventEndpoint(getDb(), bot.id);
  if (endpoint?.enabled && endpoint.events.includes('interaction_create')) return true;
  const streams = await liveBotStreamCount(bot.id);
  return streams === null || streams > 0;
}
