/**
 * Incoming channel webhooks (0044, docs/BOT_API_V2.md §5.1): an external
 * service posts into ONE channel through a secret URL
 * `/api/webhooks/{id}/{token}`. Only `sha256$<hex>` of the token is kept;
 * nothing here accepts or returns a raw token (hashing and constant-time
 * comparison live in the web app's `lib/bots/webhooks.ts`).
 *
 * A webhook post is a message with `user_id` NULL, `bot_id` NULL and a
 * `metadata.webhook` snapshot — written by `createWebhookMessage`, the
 * only path that stores an author-less message on purpose.
 */
import { and, asc, count, eq, isNull, lt, or } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { channels, channelWebhooks, messages, servers, users } from '../schema.js';
import type { MessageRow } from './messages.js';

export interface ChannelWebhookRow {
  id: string;
  serverId: string;
  channelId: string;
  name: string;
  tokenHash: string;
  enabled: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}

const webhookSelection = {
  id: channelWebhooks.id,
  serverId: channelWebhooks.serverId,
  channelId: channelWebhooks.channelId,
  name: channelWebhooks.name,
  tokenHash: channelWebhooks.tokenHash,
  enabled: channelWebhooks.enabled,
  createdBy: channelWebhooks.createdBy,
  createdByName: users.displayName,
  createdAt: channelWebhooks.createdAt,
  updatedAt: channelWebhooks.updatedAt,
  lastUsedAt: channelWebhooks.lastUsedAt,
};

function normalizeWebhook(row: Record<string, unknown>): ChannelWebhookRow {
  return {
    id: row.id as string,
    serverId: row.serverId as string,
    channelId: row.channelId as string,
    name: row.name as string,
    tokenHash: row.tokenHash as string,
    enabled: Boolean(row.enabled),
    createdBy: (row.createdBy as string | null) ?? null,
    createdByName: (row.createdByName as string | null) ?? null,
    createdAt: row.createdAt as Date,
    updatedAt: (row.updatedAt as Date | null) ?? (row.createdAt as Date),
    lastUsedAt: (row.lastUsedAt as Date | null) ?? null,
  };
}

export async function listChannelWebhooks(db: DbClient, channelId: string): Promise<ChannelWebhookRow[]> {
  const rows = await db
    .select(webhookSelection)
    .from(channelWebhooks)
    .leftJoin(users, eq(users.id, channelWebhooks.createdBy))
    .where(eq(channelWebhooks.channelId, channelId))
    .orderBy(asc(channelWebhooks.createdAt));
  return rows.map((row) => normalizeWebhook(row as Record<string, unknown>));
}

export async function countChannelWebhooks(db: DbClient, channelId: string): Promise<number> {
  const rows = await db.select({ value: count() }).from(channelWebhooks).where(eq(channelWebhooks.channelId, channelId));
  return Number(rows[0]?.value ?? 0);
}

export async function getChannelWebhookById(db: DbClient, webhookId: string): Promise<ChannelWebhookRow | null> {
  const rows = await db
    .select(webhookSelection)
    .from(channelWebhooks)
    .leftJoin(users, eq(users.id, channelWebhooks.createdBy))
    .where(eq(channelWebhooks.id, webhookId))
    .limit(1);
  return rows[0] ? normalizeWebhook(rows[0] as Record<string, unknown>) : null;
}

/**
 * The webhook a public post claims — only while its server exists (a
 * soft-deleted server's webhooks stop working, like its bots).
 */
export async function getActiveChannelWebhook(db: DbClient, webhookId: string): Promise<ChannelWebhookRow | null> {
  const rows = await db
    .select(webhookSelection)
    .from(channelWebhooks)
    .innerJoin(servers, and(eq(servers.id, channelWebhooks.serverId), isNull(servers.deletedAt)))
    .leftJoin(users, eq(users.id, channelWebhooks.createdBy))
    .where(eq(channelWebhooks.id, webhookId))
    .limit(1);
  return rows[0] ? normalizeWebhook(rows[0] as Record<string, unknown>) : null;
}

export async function createChannelWebhook(
  db: DbClient,
  input: { id?: string; serverId: string; channelId: string; name: string; tokenHash: string; createdBy: string | null },
  now: Date = new Date()
): Promise<ChannelWebhookRow> {
  const [created] = await db
    .insert(channelWebhooks)
    .values({
      ...(input.id ? { id: input.id } : {}),
      serverId: input.serverId,
      channelId: input.channelId,
      name: input.name,
      tokenHash: input.tokenHash,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: channelWebhooks.id });
  if (!created) throw new Error('createChannelWebhook: insert returned no rows');
  const row = await getChannelWebhookById(db, created.id);
  if (!row) throw new Error(`createChannelWebhook: webhook ${created.id} vanished after insert`);
  return row;
}

export async function updateChannelWebhook(
  db: DbClient,
  webhookId: string,
  patch: { name?: string; enabled?: boolean; tokenHash?: string },
  now: Date = new Date()
): Promise<ChannelWebhookRow | null> {
  const set: Record<string, unknown> = { updatedAt: now };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.tokenHash !== undefined) set.tokenHash = patch.tokenHash;
  const updated = await db
    .update(channelWebhooks)
    .set(set)
    .where(eq(channelWebhooks.id, webhookId))
    .returning({ id: channelWebhooks.id });
  if (updated.length === 0) return null;
  return getChannelWebhookById(db, webhookId);
}

export async function deleteChannelWebhook(db: DbClient, webhookId: string): Promise<boolean> {
  const deleted = await db.delete(channelWebhooks).where(eq(channelWebhooks.id, webhookId)).returning({ id: channelWebhooks.id });
  return deleted.length > 0;
}

/** Last use, written at most once a minute per webhook (the SQL throttles it). */
export async function touchChannelWebhookLastUsed(
  db: DbClient,
  webhookId: string,
  now: Date = new Date(),
  minIntervalMs = 60_000
): Promise<void> {
  const threshold = new Date(now.getTime() - minIntervalMs);
  await db
    .update(channelWebhooks)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(channelWebhooks.id, webhookId),
        or(isNull(channelWebhooks.lastUsedAt), lt(channelWebhooks.lastUsedAt, threshold))
      )
    );
}

/**
 * Store a webhook post: `user_id` and `bot_id` NULL, the webhook named in
 * `metadata.webhook`. Refuses a channel whose server is gone.
 */
export async function createWebhookMessage(
  db: DbClient,
  input: { channelId: string; content: string; metadata: Record<string, unknown> }
): Promise<MessageRow> {
  const alive = await db
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(servers, eq(servers.id, channels.serverId))
    .where(and(eq(channels.id, input.channelId), isNull(servers.deletedAt)))
    .limit(1);
  if (alive.length === 0) throw new Error(`Channel ${input.channelId} does not exist`);
  const [row] = await db
    .insert(messages)
    .values({
      channelId: input.channelId,
      userId: null,
      botId: null,
      content: input.content,
      metadata: input.metadata,
      replyToId: null,
    })
    .returning();
  if (!row) throw new Error('createWebhookMessage: insert returned no rows');
  return row as MessageRow;
}
