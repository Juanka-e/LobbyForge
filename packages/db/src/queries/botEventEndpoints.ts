/**
 * Outgoing bot event endpoints (0044, docs/BOT_API_V2.md §5.2): the HTTPS
 * URL the instance POSTs a bot's events and interactions to, signed with
 * `secret`. The secret is stored because the server must sign with it; it
 * is returned to the bot once (by the route) and never read back out.
 *
 * Failure accounting is one conditional UPDATE so concurrent deliveries
 * cannot under-count: the 20th consecutive failure switches the endpoint
 * off with `disabled_reason`, a success resets the counter.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { botEventEndpoints, bots } from '../schema.js';
import { normalizeBotChannelAccessMode, type BotChannelAccessMode } from './botChannelAccess.js';

export interface BotEventEndpointRow {
  botId: string;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
  failureCount: number;
  disabledReason: string | null;
  lastDeliveryAt: Date | null;
  lastStatus: number | null;
  createdAt: Date;
  updatedAt: Date;
}

function normalizeEndpoint(row: Record<string, unknown>): BotEventEndpointRow {
  return {
    botId: row.botId as string,
    url: row.url as string,
    secret: row.secret as string,
    events: Array.isArray(row.events) ? (row.events as unknown[]).filter((e): e is string => typeof e === 'string') : [],
    enabled: Boolean(row.enabled),
    failureCount: Number(row.failureCount ?? 0),
    disabledReason: (row.disabledReason as string | null) ?? null,
    lastDeliveryAt: (row.lastDeliveryAt as Date | null) ?? null,
    lastStatus: row.lastStatus === null || row.lastStatus === undefined ? null : Number(row.lastStatus),
    createdAt: row.createdAt as Date,
    updatedAt: (row.updatedAt as Date | null) ?? (row.createdAt as Date),
  };
}

export async function getBotEventEndpoint(db: DbClient, botId: string): Promise<BotEventEndpointRow | null> {
  const rows = await db.select().from(botEventEndpoints).where(eq(botEventEndpoints.botId, botId)).limit(1);
  return rows[0] ? normalizeEndpoint(rows[0] as Record<string, unknown>) : null;
}

/** The endpoints of several bots in one query, keyed by bot id (bots without one are absent). */
export async function listBotEventEndpoints(db: DbClient, botIds: string[]): Promise<Map<string, BotEventEndpointRow>> {
  if (botIds.length === 0) return new Map();
  const rows = await db.select().from(botEventEndpoints).where(inArray(botEventEndpoints.botId, botIds));
  const endpoints = rows.map((row) => normalizeEndpoint(row as Record<string, unknown>));
  return new Map(endpoints.map((endpoint) => [endpoint.botId, endpoint]));
}

/**
 * Create or replace a bot's endpoint. Saving re-arms it: enabled, failure
 * counter at zero, no disabled reason. `secret` omitted keeps the stored
 * one (changing the URL or the event list does not force a new secret).
 */
export async function upsertBotEventEndpoint(
  db: DbClient,
  input: { botId: string; url: string; events: string[]; secret?: string },
  now: Date = new Date()
): Promise<BotEventEndpointRow> {
  const existing = await getBotEventEndpoint(db, input.botId);
  if (!existing && !input.secret) throw new Error('upsertBotEventEndpoint: a new endpoint needs a secret');
  const values = {
    botId: input.botId,
    url: input.url,
    secret: input.secret ?? existing!.secret,
    events: input.events,
    enabled: true,
    failureCount: 0,
    disabledReason: null,
    createdAt: now,
    updatedAt: now,
  };
  const [row] = await db
    .insert(botEventEndpoints)
    .values(values)
    .onConflictDoUpdate({
      target: botEventEndpoints.botId,
      set: {
        url: values.url,
        secret: values.secret,
        events: values.events,
        enabled: true,
        failureCount: 0,
        disabledReason: null,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error('upsertBotEventEndpoint: upsert returned no rows');
  return normalizeEndpoint(row as Record<string, unknown>);
}

export async function deleteBotEventEndpoint(db: DbClient, botId: string): Promise<boolean> {
  const deleted = await db.delete(botEventEndpoints).where(eq(botEventEndpoints.botId, botId)).returning({ botId: botEventEndpoints.botId });
  return deleted.length > 0;
}

/** A manager switches a disabled endpoint back on (counter reset). */
export async function reenableBotEventEndpoint(
  db: DbClient,
  botId: string,
  now: Date = new Date()
): Promise<BotEventEndpointRow | null> {
  const rows = await db
    .update(botEventEndpoints)
    .set({ enabled: true, failureCount: 0, disabledReason: null, updatedAt: now })
    .where(eq(botEventEndpoints.botId, botId))
    .returning();
  return rows[0] ? normalizeEndpoint(rows[0] as Record<string, unknown>) : null;
}

export async function recordBotEventDeliverySuccess(
  db: DbClient,
  input: { botId: string; status: number },
  now: Date = new Date()
): Promise<void> {
  await db
    .update(botEventEndpoints)
    .set({ failureCount: 0, lastDeliveryAt: now, lastStatus: input.status })
    .where(eq(botEventEndpoints.botId, input.botId));
}

/**
 * Count one failed delivery (after its retries). Returns the row after
 * the update; `justDisabled` is true for the failure that switched it off.
 */
export async function recordBotEventDeliveryFailure(
  db: DbClient,
  input: { botId: string; status: number | null; maxFailures: number; reason: string },
  now: Date = new Date()
): Promise<{ endpoint: BotEventEndpointRow; justDisabled: boolean } | null> {
  const next = sql`${botEventEndpoints.failureCount} + 1`;
  const rows = await db
    .update(botEventEndpoints)
    .set({
      failureCount: next,
      lastDeliveryAt: now,
      lastStatus: input.status,
      enabled: sql`CASE WHEN ${botEventEndpoints.failureCount} + 1 >= ${input.maxFailures} THEN false ELSE ${botEventEndpoints.enabled} END`,
      disabledReason: sql`CASE WHEN ${botEventEndpoints.failureCount} + 1 >= ${input.maxFailures} AND ${botEventEndpoints.enabled} THEN ${input.reason} ELSE ${botEventEndpoints.disabledReason} END`,
    })
    .where(eq(botEventEndpoints.botId, input.botId))
    .returning();
  if (!rows[0]) return null;
  const endpoint = normalizeEndpoint(rows[0] as Record<string, unknown>);
  // The UPDATE's SET expressions see the OLD row: the endpoint was switched
  // off by THIS failure exactly when the counter just reached the cap.
  return { endpoint, justDisabled: !endpoint.enabled && endpoint.failureCount === input.maxFailures };
}

/** One bot of a server as the event fan-out sees it. */
export interface BotEventTarget {
  botId: string;
  botName: string;
  permissions: string[];
  /** §1.1 mode: `all` = open channels; `selected` = its grants only (none = no channel). */
  channelAccessMode: BotChannelAccessMode;
  /** The outgoing endpoint, if the bot set one (enabled or not). */
  endpoint: { url: string; events: string[]; enabled: boolean } | null;
}

/**
 * Every ENABLED custom bot of a server with its endpoint (if any), in one
 * query — the cached fan-out list. Built-in bots never receive events.
 */
export async function listBotEventTargets(db: DbClient, serverId: string): Promise<BotEventTarget[]> {
  const rows = await db
    .select({
      botId: bots.id,
      botName: bots.name,
      permissions: bots.permissions,
      channelAccessMode: bots.channelAccessMode,
      url: botEventEndpoints.url,
      events: botEventEndpoints.events,
      endpointEnabled: botEventEndpoints.enabled,
    })
    .from(bots)
    .leftJoin(botEventEndpoints, eq(botEventEndpoints.botId, bots.id))
    .where(and(eq(bots.serverId, serverId), eq(bots.type, 'custom'), eq(bots.enabled, true)));
  return rows.map((row) => ({
    botId: row.botId,
    botName: row.botName,
    permissions: Array.isArray(row.permissions)
      ? (row.permissions as unknown[]).filter((p): p is string => typeof p === 'string')
      : [],
    channelAccessMode: normalizeBotChannelAccessMode(row.channelAccessMode),
    endpoint:
      typeof row.url === 'string'
        ? {
            url: row.url,
            events: Array.isArray(row.events) ? (row.events as unknown[]).filter((e): e is string => typeof e === 'string') : [],
            enabled: Boolean(row.endpointEnabled),
          }
        : null,
  }));
}
