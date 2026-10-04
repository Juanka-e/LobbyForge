/**
 * Database reads for bot connections on `/ws/bot` (Bot API v2 §1.1, §4).
 *
 * The gateway stays read-only: it loads the bot behind a token, the set of
 * channels the bot may hear (§1.1) and the messages it forwards — always
 * from the database, never from what a publisher put on the bus, so an
 * event can carry no more than the REST API would show the same bot.
 */
import {
  getActiveBotById,
  getBotReachableChannel,
  getMessageById,
  listBotAccessibleChannels,
  listBotReachableChannels,
  listUserDisplayNames,
} from '@lobbyforge/db';
import type { BotFeedAuthor, BotFeedChannel, BotFeedMessage } from './bot-protocol.js';

/** The bot fields the gateway needs. */
export interface GatewayBot {
  id: string;
  serverId: string;
  name: string;
  type: string;
  tokenHash: string | null;
  permissions: string[];
  enabled: boolean;
}

type Db = Parameters<typeof getActiveBotById>[0];

/** The bot a token claims, while its server exists; null when there is none. */
export async function loadBot(db: unknown, botId: string): Promise<GatewayBot | null> {
  const row = await getActiveBotById(db as Db, botId);
  if (!row) return null;
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    type: row.type,
    tokenHash: row.tokenHash,
    permissions: row.permissions,
    enabled: row.enabled,
  };
}

/**
 * Postgres `undefined_table` / `undefined_column` — the 0044 migration has
 * not run yet: no `bot_channel_access` table and no
 * `bots.channel_access_mode`, so no bot can be in `selected` mode.
 */
function isPre0044Schema(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code;
  return code === '42P01' || code === '42703';
}

/**
 * §1.1 — the channels a bot hears, from the ONE shared rule in
 * `@lobbyforge/db` (`listBotReachableChannels`, the same query the web
 * app's `botCanAccessChannel` uses), by the bot's stored mode:
 *   - `all` → every text/announcement channel of its server without a
 *     role gate (the v1 rule);
 *   - `selected` → exactly its grants, still only text/announcement
 *     channels of its own server — and NONE when it has no grant left
 *     (an empty feed, never the v1 rule).
 * Ordered like the channel list; capped at `limit`. A gateway started
 * before the 0044 migration ran (no mode column, no grants table) applies
 * the v1 rule — the only mode that can exist then.
 */
export async function listBotFeedChannels(
  db: unknown,
  bot: Pick<GatewayBot, 'id' | 'serverId'>,
  limit = Number.POSITIVE_INFINITY
): Promise<BotFeedChannel[]> {
  let rows: Array<{ id: string; name: string }>;
  try {
    rows = await listBotReachableChannels(db as Db, { id: bot.id, serverId: bot.serverId });
  } catch (err) {
    if (!isPre0044Schema(err)) throw err;
    rows = await listBotAccessibleChannels(db as Db, bot.serverId);
  }
  return rows.slice(0, limit).map((c) => ({ id: c.id, name: c.name }));
}

/**
 * §1.1 for ONE channel, straight from the database (the same rule as the
 * feed) — for the rare event whose channel is beyond a capped feed set.
 */
export async function botReachesChannel(
  db: unknown,
  bot: Pick<GatewayBot, 'id' | 'serverId'>,
  channelId: string
): Promise<boolean> {
  return (await getBotReachableChannel(db as Db, { id: bot.id, serverId: bot.serverId }, channelId)) !== null;
}

export interface LoadedFeedMessage {
  /** The bot that wrote it, if any — the caller drops its own messages. */
  botId: string | null;
  message: BotFeedMessage;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

async function loadUncached(db: unknown, messageId: string, channelId: string): Promise<LoadedFeedMessage | null> {
  const row = await getMessageById(db as Db, messageId);
  // Unknown, soft-deleted, or not in the channel whose topic carried it.
  if (!row || row.channelId !== channelId) return null;
  const metadata = asRecord(row.metadata) ?? {};
  let author: BotFeedAuthor;
  if (row.userId) {
    const names = await listUserDisplayNames(db as Db, [row.userId]);
    author = { id: row.userId, displayName: names.get(row.userId) ?? null };
  } else if (row.botId || asRecord(metadata.bot)) {
    const snapshot = asRecord(metadata.bot) ?? {};
    author = { id: row.botId ?? str(snapshot.id), displayName: str(snapshot.name), bot: true };
  } else if (asRecord(metadata.webhook)) {
    const hook = asRecord(metadata.webhook)!;
    author = { id: str(hook.id), displayName: str(hook.username) ?? str(hook.name), webhook: true };
  } else {
    author = { id: null, displayName: null };
  }
  return {
    botId: row.botId ?? null,
    message: {
      id: row.id,
      channelId: row.channelId,
      content: row.content,
      author,
      createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
      editedAt: iso(row.editedAt),
      replyToId: row.replyToId ?? null,
    },
  };
}

/**
 * Several bots in one server hear the same message: one load per
 * (message, bus event) for a few seconds, shared by every connection.
 */
const MESSAGE_CACHE_TTL_MS = 5_000;
const MESSAGE_CACHE_MAX = 1_000;
const messageCache = new Map<string, { expiresAt: number; value: Promise<LoadedFeedMessage | null> }>();

export function loadFeedMessage(
  db: unknown,
  messageId: string,
  channelId: string,
  version: string
): Promise<LoadedFeedMessage | null> {
  const now = Date.now();
  const key = `${messageId}|${channelId}|${version}`;
  const cached = messageCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) messageCache.delete(key);
  while (messageCache.size >= MESSAGE_CACHE_MAX) {
    const oldest = messageCache.keys().next().value;
    if (oldest === undefined) break;
    messageCache.delete(oldest);
  }
  const value = loadUncached(db, messageId, channelId);
  messageCache.set(key, { expiresAt: now + MESSAGE_CACHE_TTL_MS, value });
  // A failed load must not be served from the cache.
  value.catch(() => {
    if (messageCache.get(key)?.value === value) messageCache.delete(key);
  });
  return value;
}

/** Test-only. */
export function __resetBotStore(): void {
  messageCache.clear();
}
