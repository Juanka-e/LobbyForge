/**
 * Interactions (0044, docs/BOT_API_V2.md §3.3–3.4) — one row per slash
 * command run. The id is what the bot answers with; every bot-side lookup
 * is bound to the bot (`id AND bot_id`), so another bot's token finds
 * nothing.
 *
 * The state changes are single conditional UPDATEs, so concurrency cannot
 * break the rules: an interaction is answered at most once, follow-ups
 * stop at the cap, and nothing is accepted after `expires_at`.
 */
import { and, eq, gt, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { botInteractions } from '../schema.js';

export const BOT_INTERACTION_STATUSES = ['pending', 'answered', 'expired', 'failed'] as const;
export type BotInteractionStatus = (typeof BOT_INTERACTION_STATUSES)[number];

export interface BotInteractionRow {
  id: string;
  botId: string;
  commandId: string | null;
  serverId: string;
  channelId: string;
  userId: string;
  commandName: string;
  options: Record<string, unknown>;
  status: BotInteractionStatus;
  response: Record<string, unknown> | null;
  followupCount: number;
  createdAt: Date;
  answeredAt: Date | null;
  expiresAt: Date;
}

function normalizeInteraction(row: Record<string, unknown>): BotInteractionRow {
  const status = (BOT_INTERACTION_STATUSES as readonly string[]).includes(row.status as string)
    ? (row.status as BotInteractionStatus)
    : 'failed';
  const options =
    row.options && typeof row.options === 'object' && !Array.isArray(row.options)
      ? (row.options as Record<string, unknown>)
      : {};
  const response =
    row.response && typeof row.response === 'object' && !Array.isArray(row.response)
      ? (row.response as Record<string, unknown>)
      : null;
  return {
    id: row.id as string,
    botId: row.botId as string,
    commandId: (row.commandId as string | null) ?? null,
    serverId: row.serverId as string,
    channelId: row.channelId as string,
    userId: row.userId as string,
    commandName: row.commandName as string,
    options,
    status,
    response,
    followupCount: Number(row.followupCount ?? 0),
    createdAt: row.createdAt as Date,
    answeredAt: (row.answeredAt as Date | null) ?? null,
    expiresAt: row.expiresAt as Date,
  };
}

export interface CreateBotInteractionInput {
  botId: string;
  commandId: string | null;
  serverId: string;
  channelId: string;
  userId: string;
  commandName: string;
  options: Record<string, unknown>;
  expiresAt: Date;
}

export async function createBotInteraction(
  db: DbClient,
  input: CreateBotInteractionInput,
  now: Date = new Date()
): Promise<BotInteractionRow> {
  const [row] = await db
    .insert(botInteractions)
    .values({ ...input, status: 'pending', createdAt: now })
    .returning();
  if (!row) throw new Error('createBotInteraction: insert returned no rows');
  return normalizeInteraction(row as Record<string, unknown>);
}

/** The interaction, only if it belongs to this bot (anything else: null → 404). */
export async function getBotInteractionForBot(
  db: DbClient,
  interactionId: string,
  botId: string
): Promise<BotInteractionRow | null> {
  const rows = await db
    .select()
    .from(botInteractions)
    .where(and(eq(botInteractions.id, interactionId), eq(botInteractions.botId, botId)))
    .limit(1);
  return rows[0] ? normalizeInteraction(rows[0] as Record<string, unknown>) : null;
}

/**
 * Claim the one answer: pending → answered, only while unexpired. Returns
 * the updated row, or null when it was already answered, expired or is
 * not this bot's (the caller re-reads to tell which).
 */
export async function claimBotInteractionAnswer(
  db: DbClient,
  input: { interactionId: string; botId: string; response: Record<string, unknown> },
  now: Date = new Date()
): Promise<BotInteractionRow | null> {
  const rows = await db
    .update(botInteractions)
    .set({ status: 'answered', response: input.response, answeredAt: now })
    .where(
      and(
        eq(botInteractions.id, input.interactionId),
        eq(botInteractions.botId, input.botId),
        eq(botInteractions.status, 'pending'),
        gt(botInteractions.expiresAt, now)
      )
    )
    .returning();
  return rows[0] ? normalizeInteraction(rows[0] as Record<string, unknown>) : null;
}

/**
 * Undo a claim whose answer could not be delivered (the public message
 * failed to post), so the bot may try again. Only touches a row this
 * claim answered.
 */
export async function releaseBotInteractionAnswer(
  db: DbClient,
  input: { interactionId: string; botId: string; answeredAt: Date }
): Promise<void> {
  await db
    .update(botInteractions)
    .set({ status: 'pending', response: null, answeredAt: null })
    .where(
      and(
        eq(botInteractions.id, input.interactionId),
        eq(botInteractions.botId, input.botId),
        eq(botInteractions.status, 'answered'),
        eq(botInteractions.answeredAt, input.answeredAt)
      )
    );
}

/**
 * Count one follow-up: only on an answered, unexpired interaction below
 * the cap. Returns the updated row or null (caller re-reads for the reason).
 */
export async function claimBotInteractionFollowup(
  db: DbClient,
  input: { interactionId: string; botId: string; maxFollowups: number },
  now: Date = new Date()
): Promise<BotInteractionRow | null> {
  const rows = await db
    .update(botInteractions)
    .set({ followupCount: sql`${botInteractions.followupCount} + 1` })
    .where(
      and(
        eq(botInteractions.id, input.interactionId),
        eq(botInteractions.botId, input.botId),
        eq(botInteractions.status, 'answered'),
        gt(botInteractions.expiresAt, now),
        lt(botInteractions.followupCount, input.maxFollowups)
      )
    )
    .returning();
  return rows[0] ? normalizeInteraction(rows[0] as Record<string, unknown>) : null;
}

/** Give back a follow-up slot whose message could not be posted. */
export async function releaseBotInteractionFollowup(
  db: DbClient,
  input: { interactionId: string; botId: string }
): Promise<void> {
  await db
    .update(botInteractions)
    .set({ followupCount: sql`GREATEST(${botInteractions.followupCount} - 1, 0)` })
    .where(and(eq(botInteractions.id, input.interactionId), eq(botInteractions.botId, input.botId)));
}

/**
 * Sweep: every pending interaction past its deadline becomes `expired`.
 * Scoped to one bot when given (uses idx_bot_interactions_bot_status).
 * Returns how many rows changed.
 */
export async function expireBotInteractions(
  db: DbClient,
  input: { botId?: string } = {},
  now: Date = new Date()
): Promise<number> {
  const conditions = [eq(botInteractions.status, 'pending'), lte(botInteractions.expiresAt, now)];
  if (input.botId) conditions.push(eq(botInteractions.botId, input.botId));
  const rows = await db
    .update(botInteractions)
    .set({ status: 'expired' })
    .where(and(...conditions))
    .returning({ id: botInteractions.id });
  return rows.length;
}

/**
 * Mark an interaction failed whatever its live state (pending or answered),
 * and drop its stored answer — e.g. its invoker lost access to the channel,
 * so an ephemeral answer must not reach them. An expired row is left alone.
 * Returns false when nothing changed.
 */
export async function failBotInteractionNow(db: DbClient, interactionId: string, botId: string): Promise<boolean> {
  const rows = await db
    .update(botInteractions)
    .set({ status: 'failed', response: null })
    .where(
      and(
        eq(botInteractions.id, interactionId),
        eq(botInteractions.botId, botId),
        inArray(botInteractions.status, ['pending', 'answered'])
      )
    )
    .returning({ id: botInteractions.id });
  return rows.length > 0;
}

/** Interactions are kept this long after `expires_at`, then deleted. */
export const BOT_INTERACTION_RETENTION_MS = 24 * 60 * 60_000;

/**
 * Retention sweep for one bot (docs/BOT_API_V2.md §3.4), two indexed
 * statements on `idx_bot_interactions_bot_status`:
 *   1. a row past `expires_at` keeps no answer text: `response` → NULL
 *      (nothing can follow up any more; an ephemeral answer only lived
 *      there);
 *   2. a row more than `retentionMs` (24 h) past `expires_at` is deleted
 *      — a late respond then gets 404 instead of 410.
 */
export async function pruneBotInteractions(
  db: DbClient,
  input: { botId: string; retentionMs?: number },
  now: Date = new Date()
): Promise<{ cleared: number; deleted: number }> {
  const cutoff = new Date(now.getTime() - (input.retentionMs ?? BOT_INTERACTION_RETENTION_MS));
  const cleared = await db
    .update(botInteractions)
    .set({ response: null })
    .where(
      and(
        eq(botInteractions.botId, input.botId),
        lte(botInteractions.expiresAt, now),
        isNotNull(botInteractions.response)
      )
    )
    .returning({ id: botInteractions.id });
  const deleted = await db
    .delete(botInteractions)
    .where(and(eq(botInteractions.botId, input.botId), lt(botInteractions.expiresAt, cutoff)))
    .returning({ id: botInteractions.id });
  return { cleared: cleared.length, deleted: deleted.length };
}

/** Mark a still-pending interaction failed (e.g. its bot can no longer be reached). */
export async function failBotInteraction(db: DbClient, interactionId: string, botId: string): Promise<boolean> {
  const rows = await db
    .update(botInteractions)
    .set({ status: 'failed' })
    .where(
      and(eq(botInteractions.id, interactionId), eq(botInteractions.botId, botId), eq(botInteractions.status, 'pending'))
    )
    .returning({ id: botInteractions.id });
  return rows.length > 0;
}
