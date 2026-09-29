/**
 * Bot queries — thin wrappers over the Drizzle client.
 *
 * A bot is an identity that belongs to exactly ONE server (`bots.server_id`,
 * cascade-deleted with it). Custom bots are driven from outside through the
 * Bot API with a token; the built-in bots (`welcome`, `moderation`) run
 * inside the web app. Either way the route layer decides what a bot may do
 * — these helpers only read and write rows.
 *
 * Tokens: only a hash is ever stored (`token_hash`). Nothing here returns
 * or accepts a raw token; hashing and constant-time comparison live in the
 * web app's `lib/bots/token.ts`.
 */
import { and, asc, count, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { bots, channelRoleOverrides, channels, servers, users } from '../schema.js';
import type { ChannelRow } from './channels.js';

/** The built-in bot types — at most one of each per server (0037 index). */
export const BUILT_IN_BOT_TYPES = ['welcome', 'moderation'] as const;
export type BuiltInBotType = (typeof BUILT_IN_BOT_TYPES)[number];

/** Channel types a bot may read and post in. */
export const BOT_MESSAGE_CHANNEL_TYPES = ['text', 'announcement'] as const;

export interface BotRow {
  id: string;
  serverId: string;
  name: string;
  type: string;
  tokenHash: string | null;
  tokenIssuedAt: Date | null;
  permissions: string[];
  settings: Record<string, unknown>;
  enabled: boolean;
  createdBy: string | null;
  /** Display name of `createdBy`; null when unknown or the user is gone. */
  createdByName: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function isBuiltInBotType(type: string): type is BuiltInBotType {
  return (BUILT_IN_BOT_TYPES as readonly string[]).includes(type);
}

const botSelection = {
  id: bots.id,
  serverId: bots.serverId,
  name: bots.name,
  type: bots.type,
  tokenHash: bots.tokenHash,
  tokenIssuedAt: bots.tokenIssuedAt,
  permissions: bots.permissions,
  settings: bots.settings,
  enabled: bots.enabled,
  createdBy: bots.createdBy,
  createdByName: users.displayName,
  lastUsedAt: bots.lastUsedAt,
  createdAt: bots.createdAt,
  updatedAt: bots.updatedAt,
};

type RawBotRow = {
  [K in keyof typeof botSelection]: unknown;
};

/**
 * JSONB columns come back as whatever was stored. The legacy default of
 * `permissions` was an object, so anything that is not an array of
 * strings reads as "no permissions" — never as a grant.
 */
function normalizeBotRow(row: RawBotRow): BotRow {
  const permissions = Array.isArray(row.permissions)
    ? (row.permissions as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const settings =
    row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
      ? (row.settings as Record<string, unknown>)
      : {};
  return {
    id: row.id as string,
    serverId: row.serverId as string,
    name: row.name as string,
    type: row.type as string,
    tokenHash: (row.tokenHash as string | null) ?? null,
    tokenIssuedAt: (row.tokenIssuedAt as Date | null) ?? null,
    permissions,
    settings,
    enabled: Boolean(row.enabled),
    createdBy: (row.createdBy as string | null) ?? null,
    createdByName: (row.createdByName as string | null) ?? null,
    lastUsedAt: (row.lastUsedAt as Date | null) ?? null,
    createdAt: row.createdAt as Date,
    updatedAt: (row.updatedAt as Date | null) ?? (row.createdAt as Date),
  };
}

/** Every bot of a server, oldest first (built-ins and custom bots alike). */
export async function listBotsForServer(db: DbClient, serverId: string): Promise<BotRow[]> {
  const rows = await db
    .select(botSelection)
    .from(bots)
    .leftJoin(users, eq(users.id, bots.createdBy))
    .where(eq(bots.serverId, serverId))
    .orderBy(asc(bots.createdAt));
  return rows.map((row) => normalizeBotRow(row as RawBotRow));
}

export async function getBotById(db: DbClient, botId: string): Promise<BotRow | null> {
  const rows = await db
    .select(botSelection)
    .from(bots)
    .leftJoin(users, eq(users.id, bots.createdBy))
    .where(eq(bots.id, botId))
    .limit(1);
  const row = rows[0];
  return row ? normalizeBotRow(row as RawBotRow) : null;
}

/**
 * The bot a Bot API token claims to be — only while its server exists
 * (a soft-deleted server's bots stop authenticating).
 */
export async function getActiveBotById(db: DbClient, botId: string): Promise<BotRow | null> {
  const rows = await db
    .select(botSelection)
    .from(bots)
    .innerJoin(servers, and(eq(servers.id, bots.serverId), isNull(servers.deletedAt)))
    .leftJoin(users, eq(users.id, bots.createdBy))
    .where(eq(bots.id, botId))
    .limit(1);
  const row = rows[0];
  return row ? normalizeBotRow(row as RawBotRow) : null;
}

/** The server's Welcome or Moderation bot, if it was ever set up. */
export async function getBuiltInBotForServer(
  db: DbClient,
  serverId: string,
  type: BuiltInBotType
): Promise<BotRow | null> {
  const rows = await db
    .select(botSelection)
    .from(bots)
    .leftJoin(users, eq(users.id, bots.createdBy))
    .where(and(eq(bots.serverId, serverId), eq(bots.type, type)))
    .orderBy(asc(bots.createdAt))
    .limit(1);
  const row = rows[0];
  return row ? normalizeBotRow(row as RawBotRow) : null;
}

/** How many bots of one type a server has (the app caps custom bots). */
export async function countBotsForServer(
  db: DbClient,
  serverId: string,
  type: string
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(bots)
    .where(and(eq(bots.serverId, serverId), eq(bots.type, type)));
  return Number(rows[0]?.value ?? 0);
}

export interface CreateBotInput {
  /** Optional pre-generated id — lets the caller mint the token first. */
  id?: string;
  serverId: string;
  name: string;
  type: string;
  permissions: string[];
  settings?: Record<string, unknown>;
  enabled?: boolean;
  createdBy?: string | null;
  /** Hash of the bot's first token (never the token itself). */
  tokenHash?: string | null;
}

function insertValues(input: CreateBotInput, now: Date) {
  return {
    ...(input.id ? { id: input.id } : {}),
    serverId: input.serverId,
    name: input.name,
    type: input.type,
    permissions: input.permissions,
    settings: input.settings ?? {},
    enabled: input.enabled ?? true,
    createdBy: input.createdBy ?? null,
    tokenHash: input.tokenHash ?? null,
    tokenIssuedAt: input.tokenHash ? now : null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Insert a bot and return the stored row (with its installer's name). */
export async function createBot(
  db: DbClient,
  input: CreateBotInput,
  now: Date = new Date()
): Promise<BotRow> {
  const [created] = await db
    .insert(bots)
    .values(insertValues(input, now))
    .returning({ id: bots.id });
  if (!created) throw new Error('createBot: insert returned no rows');
  const row = await getBotById(db, created.id);
  if (!row) throw new Error(`createBot: bot ${created.id} vanished after insert`);
  return row;
}

/**
 * Create a built-in bot unless the server already has one of that type,
 * and return whichever row exists afterwards. Concurrent calls are safe:
 * the partial unique index turns the loser's insert into a no-op.
 */
export async function ensureBuiltInBot(
  db: DbClient,
  input: CreateBotInput & { type: BuiltInBotType },
  now: Date = new Date()
): Promise<{ bot: BotRow; created: boolean }> {
  const existing = await getBuiltInBotForServer(db, input.serverId, input.type);
  if (existing) return { bot: existing, created: false };
  const inserted = await db
    .insert(bots)
    .values(insertValues({ ...input, tokenHash: null }, now))
    .onConflictDoNothing()
    .returning({ id: bots.id });
  const bot = await getBuiltInBotForServer(db, input.serverId, input.type);
  if (!bot) throw new Error(`ensureBuiltInBot: no ${input.type} bot for ${input.serverId}`);
  return { bot, created: inserted.length > 0 };
}

export interface UpdateBotInput {
  name?: string;
  enabled?: boolean;
  permissions?: string[];
  settings?: Record<string, unknown>;
}

/** Patch a bot. Returns the updated row, or null when it does not exist. */
export async function updateBot(
  db: DbClient,
  botId: string,
  input: UpdateBotInput,
  now: Date = new Date()
): Promise<BotRow | null> {
  const patch: Record<string, unknown> = { updatedAt: now };
  if (input.name !== undefined) patch.name = input.name;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.permissions !== undefined) patch.permissions = input.permissions;
  if (input.settings !== undefined) patch.settings = input.settings;
  const updated = await db
    .update(bots)
    .set(patch)
    .where(eq(bots.id, botId))
    .returning({ id: bots.id });
  if (updated.length === 0) return null;
  return getBotById(db, botId);
}

/**
 * Replace (rotate) or clear (revoke) a bot's token hash. The previous
 * token stops working the moment this commits. Returns null when the bot
 * does not exist.
 */
export async function setBotTokenHash(
  db: DbClient,
  botId: string,
  tokenHash: string | null,
  now: Date = new Date()
): Promise<BotRow | null> {
  const updated = await db
    .update(bots)
    .set({ tokenHash, tokenIssuedAt: tokenHash ? now : null, updatedAt: now })
    .where(eq(bots.id, botId))
    .returning({ id: bots.id });
  if (updated.length === 0) return null;
  return getBotById(db, botId);
}

/** Delete a bot. Its messages stay (bot_id → NULL, metadata keeps the name). */
export async function deleteBot(db: DbClient, botId: string): Promise<boolean> {
  const deleted = await db.delete(bots).where(eq(bots.id, botId)).returning({ id: bots.id });
  return deleted.length > 0;
}

/**
 * Record bot activity. Throttled in SQL: the row is only written when the
 * stored value is older than `minIntervalMs`, so a busy bot costs one
 * write a minute, not one per request.
 */
export async function touchBotLastUsed(
  db: DbClient,
  botId: string,
  now: Date = new Date(),
  minIntervalMs = 60_000
): Promise<void> {
  const threshold = new Date(now.getTime() - minIntervalMs);
  await db
    .update(bots)
    .set({ lastUsedAt: now })
    .where(and(eq(bots.id, botId), or(isNull(bots.lastUsedAt), lt(bots.lastUsedAt, threshold))));
}

/**
 * The channels of a server a bot may use: text-like channels that are
 * open to every member. A role-gated channel (0028 overrides) is never
 * reachable by a bot — a bot holds no roles, and there is no way to hand
 * it one, so "private" stays private. Ordered like the channel list.
 */
export async function listBotAccessibleChannels(
  db: DbClient,
  serverId: string
): Promise<ChannelRow[]> {
  const gated = await db
    .selectDistinct({ channelId: channelRoleOverrides.channelId })
    .from(channelRoleOverrides)
    .innerJoin(channels, eq(channelRoleOverrides.channelId, channels.id))
    .where(eq(channels.serverId, serverId));
  const gatedIds = new Set(gated.map((row) => row.channelId));
  const rows = (await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.serverId, serverId),
        inArray(channels.type, [...BOT_MESSAGE_CHANNEL_TYPES])
      )
    )
    .orderBy(asc(channels.position), asc(channels.createdAt))) as ChannelRow[];
  return rows.filter((channel) => !gatedIds.has(channel.id));
}

/** True when a channel has no role gate (so a bot may use it). */
export async function isChannelOpenToBots(db: DbClient, channelId: string): Promise<boolean> {
  const rows = await db
    .select({ id: channelRoleOverrides.id })
    .from(channelRoleOverrides)
    .where(eq(channelRoleOverrides.channelId, channelId))
    .limit(1);
  return rows.length === 0;
}

/** Display names for a set of users (message authors shown to a bot). */
export async function listUserDisplayNames(
  db: DbClient,
  userIds: readonly string[]
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const rows = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, unique));
  for (const row of rows) out.set(row.id, row.displayName);
  return out;
}
