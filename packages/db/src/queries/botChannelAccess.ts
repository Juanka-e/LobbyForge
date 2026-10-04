/**
 * Bot channel access (0044, docs/BOT_API_V2.md §1.1) — the ONE rule for
 * which channels a bot reaches, shared by the web app
 * (`apps/web/lib/bots/access.ts`) and the WebSocket gateway.
 *
 * The mode is stored explicitly on the bot (`bots.channel_access_mode`):
 *   - `all` → every text / announcement channel of its own server without
 *     a role gate (the v1 rule); grant rows are ignored (there are none:
 *     switching to `all` deletes them);
 *   - `selected` → exactly its `bot_channel_access` rows — still only text
 *     / announcement channels of its own server (a row pointing anywhere
 *     else is ignored, never honoured) — and NO channel at all when there
 *     are no rows.
 *
 * "No rows" never means "all": a grant cascades away with its channel, and
 * revoking or deleting a bot's last channel must leave it with nothing, not
 * widen it to every open channel.
 *
 * Who may write a row (role-gated channels need MANAGE_CHANNELS + seeing
 * the channel) is the route's business; these helpers read and write.
 */
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { botChannelAccess, bots, channels } from '../schema.js';
import { BOT_MESSAGE_CHANNEL_TYPES, isChannelOpenToBots, listBotAccessibleChannels } from './bots.js';
import type { ChannelRow } from './channels.js';

/** The part of a bot row the access rule needs. */
export interface BotAccessSubject {
  id: string;
  serverId: string;
}

export const BOT_CHANNEL_ACCESS_MODES = ['all', 'selected'] as const;
export type BotChannelAccessMode = (typeof BOT_CHANNEL_ACCESS_MODES)[number];

/** A bot's stored access: its mode and its grant rows. */
export interface BotChannelAccessState {
  mode: BotChannelAccessMode;
  /** The grant rows (meaningful in `selected` mode only). */
  channelIds: string[];
}

/**
 * Anything but the literal `'all'` reads as `selected` — an unknown value
 * (or a missing row) narrows a bot to its grants, never widens it.
 */
export function normalizeBotChannelAccessMode(value: unknown): BotChannelAccessMode {
  return value === 'all' ? 'all' : 'selected';
}

function isBotChannelType(type: string): boolean {
  return (BOT_MESSAGE_CHANNEL_TYPES as readonly string[]).includes(type);
}

/** The channel ids a bot was granted explicitly (the rows, whatever the mode). */
export async function listBotChannelAccessIds(db: DbClient, botId: string): Promise<string[]> {
  const rows = await db
    .select({ channelId: botChannelAccess.channelId })
    .from(botChannelAccess)
    .where(eq(botChannelAccess.botId, botId));
  return rows.map((row) => row.channelId);
}

/**
 * The bot's mode and grants in one query. An unknown bot reads as
 * `selected` with no grants: it reaches nothing.
 */
export async function getBotChannelAccessState(db: DbClient, botId: string): Promise<BotChannelAccessState> {
  const rows = await db
    .select({ mode: bots.channelAccessMode, channelId: botChannelAccess.channelId })
    .from(bots)
    .leftJoin(botChannelAccess, eq(botChannelAccess.botId, bots.id))
    .where(eq(bots.id, botId));
  if (rows.length === 0) return { mode: 'selected', channelIds: [] };
  const mode = normalizeBotChannelAccessMode(rows[0]!.mode);
  const channelIds = rows.map((row) => row.channelId).filter((id): id is string => typeof id === 'string');
  return { mode, channelIds };
}

/**
 * Explicit grants of every bot of a server, in one query — for fan-out
 * and the composer's command list (no query per bot). The MODE is not
 * here: it travels with the bot row (`BotEventTarget.channelAccessMode`,
 * `ServerCommandRow.bot.channelAccessMode`), so a bot missing from this map
 * simply has no grants — which in `selected` mode means no channel.
 */
export async function listBotChannelAccessForServer(
  db: DbClient,
  serverId: string
): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ botId: botChannelAccess.botId, channelId: botChannelAccess.channelId })
    .from(botChannelAccess)
    .innerJoin(bots, eq(bots.id, botChannelAccess.botId))
    .where(eq(bots.serverId, serverId));
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const list = out.get(row.botId) ?? [];
    list.push(row.channelId);
    out.set(row.botId, list);
  }
  return out;
}

/** Every channel this bot reaches, ordered like the channel list. */
export async function listBotReachableChannels(
  db: DbClient,
  bot: BotAccessSubject
): Promise<ChannelRow[]> {
  const access = await getBotChannelAccessState(db, bot.id);
  if (access.mode === 'all') return listBotAccessibleChannels(db, bot.serverId);
  // `selected` with no rows: nothing — never the v1 rule.
  if (access.channelIds.length === 0) return [];
  const rows = (await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.serverId, bot.serverId),
        inArray(channels.id, access.channelIds),
        inArray(channels.type, [...BOT_MESSAGE_CHANNEL_TYPES])
      )
    )
    .orderBy(asc(channels.position), asc(channels.createdAt))) as ChannelRow[];
  return rows;
}

/**
 * The channel, if this bot may use it; null otherwise ("not found" to the
 * bot — it never learns whether a channel it cannot use exists).
 */
export async function getBotReachableChannel(
  db: DbClient,
  bot: BotAccessSubject,
  channelId: string
): Promise<ChannelRow | null> {
  const rows = (await db.select().from(channels).where(eq(channels.id, channelId)).limit(1)) as ChannelRow[];
  const channel = rows[0];
  if (!channel || channel.serverId !== bot.serverId || !isBotChannelType(channel.type)) return null;
  const access = await getBotChannelAccessState(db, bot.id);
  if (access.mode === 'selected') return access.channelIds.includes(channel.id) ? channel : null;
  return (await isChannelOpenToBots(db, channel.id)) ? channel : null;
}

/**
 * Grant one channel — only while the bot is in `selected` mode (the bot row
 * is locked, so a concurrent switch to `all` cannot interleave). Returns
 * false when nothing was written: the grant existed, or the bot is in `all`
 * mode (or gone).
 */
export async function grantBotChannelAccess(
  db: DbClient,
  input: { botId: string; channelId: string; grantedBy: string | null },
  now: Date = new Date()
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [bot] = await tx
      .select({ mode: bots.channelAccessMode })
      .from(bots)
      .where(eq(bots.id, input.botId))
      .limit(1)
      .for('update');
    if (!bot || normalizeBotChannelAccessMode(bot.mode) !== 'selected') return false;
    const inserted = await tx
      .insert(botChannelAccess)
      .values({ botId: input.botId, channelId: input.channelId, grantedBy: input.grantedBy, createdAt: now })
      .onConflictDoNothing()
      .returning({ botId: botChannelAccess.botId });
    return inserted.length > 0;
  });
}

/**
 * Revoke one channel. Returns false when there was no such grant. Removing
 * the last row leaves a `selected` bot with NO channel — the safe outcome,
 * so there is nothing to check first (and nothing two concurrent revokes
 * can race on).
 */
export async function revokeBotChannelAccess(db: DbClient, botId: string, channelId: string): Promise<boolean> {
  const deleted = await db
    .delete(botChannelAccess)
    .where(and(eq(botChannelAccess.botId, botId), eq(botChannelAccess.channelId, channelId)))
    .returning({ botId: botChannelAccess.botId });
  return deleted.length > 0;
}

export type SetBotChannelAccessInput =
  | { botId: string; mode: 'all' }
  | { botId: string; mode: 'selected'; channelIds: readonly string[]; grantedBy: string | null };

/**
 * Set a bot's mode and grants in one transaction (the bot row is updated
 * first, which also locks it):
 *   - `all` → mode `all`, every grant row deleted;
 *   - `selected` → mode `selected`, rows replaced by `channelIds`: rows not
 *     in the list are deleted, new ones inserted, and grants that stay keep
 *     their `granted_by` / `created_at` (who granted a private channel
 *     still counts when that channel's role gate changes later).
 */
export async function setBotChannelAccess(
  db: DbClient,
  input: SetBotChannelAccessInput,
  now: Date = new Date()
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(bots).set({ channelAccessMode: input.mode }).where(eq(bots.id, input.botId));
    if (input.mode === 'all') {
      await tx.delete(botChannelAccess).where(eq(botChannelAccess.botId, input.botId));
      return;
    }
    const unique = Array.from(new Set(input.channelIds));
    if (unique.length === 0) {
      await tx.delete(botChannelAccess).where(eq(botChannelAccess.botId, input.botId));
      return;
    }
    await tx
      .delete(botChannelAccess)
      .where(and(eq(botChannelAccess.botId, input.botId), notInArray(botChannelAccess.channelId, unique)));
    await tx
      .insert(botChannelAccess)
      .values(unique.map((channelId) => ({ botId: input.botId, channelId, grantedBy: input.grantedBy, createdAt: now })))
      .onConflictDoNothing();
  });
}

/** Every grant on one channel, with who made it (channel policy changes). */
export async function listBotChannelGrantsForChannel(
  db: DbClient,
  channelId: string
): Promise<Array<{ botId: string; grantedBy: string | null }>> {
  const rows = await db
    .select({ botId: botChannelAccess.botId, grantedBy: botChannelAccess.grantedBy })
    .from(botChannelAccess)
    .where(eq(botChannelAccess.channelId, channelId));
  return rows.map((row) => ({ botId: row.botId, grantedBy: row.grantedBy ?? null }));
}

/** Drop these bots' grants on one channel. Returns the bots that lost one. */
export async function revokeBotChannelGrantsForChannel(
  db: DbClient,
  channelId: string,
  botIds: readonly string[]
): Promise<string[]> {
  if (botIds.length === 0) return [];
  const deleted = await db
    .delete(botChannelAccess)
    .where(and(eq(botChannelAccess.channelId, channelId), inArray(botChannelAccess.botId, [...botIds])))
    .returning({ botId: botChannelAccess.botId });
  return deleted.map((row) => row.botId);
}
