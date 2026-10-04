/**
 * Bot events (docs/BOT_API_V2.md §4) — who hears what, and how it leaves
 * the web app.
 *
 * Two ways out:
 *   - the event STREAM (WebSocket gateway): interactions and member events
 *     are published on Redis `lf:{env}:bot-events:{botId}` with the §4.2
 *     `data` payload; message events need nothing from here — the gateway
 *     reads the chat bus itself and filters per bot;
 *   - the event ENDPOINT (HTTPS, signed): every event the bot subscribed
 *     to, queued through `event-delivery.ts`.
 *
 * Ephemeral interaction answers go to the invoker only, on Redis
 * `lf:{env}:user-events:{uid}` (gateway topic `user:{uid}`).
 *
 * Bounded fan-out: deciding who gets a message event must not cost a query
 * per bot per message. Each server's targets (enabled custom bots, their
 * permissions, §1.1 mode, endpoint and channel grants) are cached per process
 * for 15 s — two queries per fill — and dropped at once in this process by
 * every change made through the API (`invalidateBotEventTargets`); other
 * processes catch up within 15 s. A stale entry can only cause an extra or
 * a missed DECISION: every endpoint delivery re-checks the current bot row
 * and channel access right before it is sent (`DeliveryJob.authorize`), so
 * no event ever reaches a bot that may not see it.
 *
 * Redis is imported lazily so that importing this module never opens a
 * connection (route tests that never emit stay offline).
 */
import {
  getChannelById,
  getUserById,
  isChannelOpenToBots,
  listBotChannelAccessForServer,
  listBotEventTargets,
  listUserDisplayNames,
  type BotEventTarget,
  type BotRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import type { AccessInvalidationEvent } from '@/lib/access-invalidation';
import { botCanAccessChannel, botReachesChannel, isAllChannelsMode, listBotChannels } from './access';
import { enqueueDelivery, type DeliveryJob } from './event-delivery';
import { botHasPermission } from './permissions';
import type { BotEventName } from './catalog';

/** Channel types a bot can use (the same list as `BOT_MESSAGE_CHANNEL_TYPES` in @lobbyforge/db). */
const BOT_CHANNEL_TYPES: ReadonlySet<string> = new Set(['text', 'announcement']);

function envPrefix(): string {
  return process.env.NODE_ENV || 'dev';
}

/** Redis channel of one bot's event stream (consumed by the gateway). */
export function botEventsChannel(botId: string): string {
  return `lf:${envPrefix()}:bot-events:${botId}`;
}

/** Redis channel of one user's private events (gateway topic `user:{uid}`). */
export function userEventsChannel(userId: string): string {
  return `lf:${envPrefix()}:user-events:${userId}`;
}

/** One shared lazy import (concurrent first publishes wait on the same promise). */
let redisModule: Promise<typeof import('@/lib/redis')> | null = null;

async function publish(channel: string, payload: unknown): Promise<void> {
  try {
    redisModule ??= import('@/lib/redis');
    const { redis } = await redisModule;
    await redis.publish(channel, JSON.stringify(payload));
  } catch (err) {
    // Events are at-most-once: a Redis blip loses the event, never the request.
    console.warn(`[bot-events] publish failed on ${channel}: ${(err as Error).message}`);
  }
}

/** Publish a §4.2 `data` payload to a bot's stream. */
export function publishBotEvent(botId: string, data: Record<string, unknown> & { event: BotEventName }): Promise<void> {
  return publish(botEventsChannel(botId), data);
}

/** Publish a private event for one user (ephemeral interaction answers). */
export function publishUserEvent(userId: string, payload: Record<string, unknown> & { type: string }): Promise<void> {
  return publish(userEventsChannel(userId), { ...payload, at: new Date().toISOString() });
}

// ── per-server target cache ─────────────────────────────────────────────

const TARGET_TTL_MS = 15_000;
const MAX_CACHED_SERVERS = 2_000;

export interface CachedBotTarget extends BotEventTarget {
  /** Grant rows — what a `selected`-mode bot reaches ([] = nothing); ignored in `all` mode. */
  granted: string[];
}

interface TargetEntry {
  targets: CachedBotTarget[];
  loadedAt: number;
}

const targetCache = new Map<string, TargetEntry>();

export async function getBotEventTargets(serverId: string): Promise<CachedBotTarget[]> {
  const now = Date.now();
  const hit = targetCache.get(serverId);
  if (hit && now - hit.loadedAt < TARGET_TTL_MS) return hit.targets;
  const targets = await listBotEventTargets(getDb(), serverId);
  // Most servers have no custom bot: skip the grants query entirely.
  const grants = targets.length > 0 ? await listBotChannelAccessForServer(getDb(), serverId) : new Map<string, string[]>();
  const entry: TargetEntry = {
    targets: targets.map((t) => ({ ...t, granted: grants.get(t.botId) ?? [] })),
    loadedAt: now,
  };
  if (!targetCache.has(serverId) && targetCache.size >= MAX_CACHED_SERVERS) {
    const oldest = targetCache.keys().next().value;
    if (oldest !== undefined) targetCache.delete(oldest);
  }
  targetCache.set(serverId, entry);
  return entry.targets;
}

export function invalidateBotEventTargets(serverId: string): void {
  targetCache.delete(serverId);
}

let invalidationModule: Promise<typeof import('@/lib/access-invalidation')> | null = null;

/**
 * A bot changed (access, permissions, enabled, token, deleted): drop the
 * cached targets here and tell the gateway to recompute or close the bot's
 * stream.
 */
export function notifyBotChanged(input: {
  serverId: string;
  botId: string;
  reason: Extract<AccessInvalidationEvent, { kind: 'bot-access' }>['reason'];
}): void {
  invalidateBotEventTargets(input.serverId);
  // Lazy: `access-invalidation` opens the shared Redis connection on import.
  invalidationModule ??= import('@/lib/access-invalidation');
  void invalidationModule
    .then(({ publishAccessInvalidation }) =>
      publishAccessInvalidation({ kind: 'bot-access', serverId: input.serverId, botId: input.botId, reason: input.reason })
    )
    .catch((err) => console.warn('[bot-events] bot-access invalidation not published:', (err as Error).message));
}

function wantsEndpointEvent(target: CachedBotTarget, event: BotEventName): boolean {
  return Boolean(
    target.endpoint?.enabled && target.endpoint.events.includes(event) && target.permissions.includes('receive_events')
  );
}

// ── message events (endpoints only — the gateway serves the stream) ─────

export interface MessageEventAuthor {
  /** user id, bot id or webhook id */
  id: string | null;
  displayName: string | null;
  bot?: true;
  webhook?: true;
}

export interface MessageEventInput {
  serverId: string;
  /** `type` when the caller has it; otherwise it is looked up — only if some bot listens. */
  channel: { id: string; type?: string };
  event: 'message_create' | 'message_update' | 'message_delete';
  message: {
    id: string;
    content?: string;
    createdAt?: string;
    editedAt?: string | null;
    replyToId?: string | null;
    /** The member who wrote it (display name looked up only if someone listens). */
    userId?: string | null;
    /** Set for a bot's message — that bot never hears its own messages. */
    bot?: { id: string; name: string } | null;
    webhook?: { id: string; name: string } | null;
  };
}

async function resolveAuthor(message: MessageEventInput['message']): Promise<MessageEventAuthor> {
  if (message.bot) return { id: message.bot.id, displayName: message.bot.name, bot: true };
  if (message.webhook) return { id: message.webhook.id, displayName: message.webhook.name, webhook: true };
  if (message.userId) {
    const names = await listUserDisplayNames(getDb(), [message.userId]);
    return { id: message.userId, displayName: names.get(message.userId) ?? null };
  }
  return { id: null, displayName: null };
}

async function emitMessageEventNow(input: MessageEventInput): Promise<number> {
  if (input.channel.type !== undefined && !BOT_CHANNEL_TYPES.has(input.channel.type)) return 0;
  const targets = await getBotEventTargets(input.serverId);
  const candidates = targets.filter(
    (t) => wantsEndpointEvent(t, input.event) && t.permissions.includes('read_messages') && t.botId !== input.message.bot?.id
  );
  if (candidates.length === 0) return 0;
  if (input.channel.type === undefined) {
    const channel = await getChannelById(getDb(), input.channel.id);
    if (!channel || channel.serverId !== input.serverId || !BOT_CHANNEL_TYPES.has(channel.type)) return 0;
  }
  // One gate lookup per message, and only when an `all`-mode bot listens.
  const needsGate = candidates.some((t) => isAllChannelsMode(t.channelAccessMode));
  const openToBots = needsGate ? await isChannelOpenToBots(getDb(), input.channel.id) : false;
  const receivers = candidates.filter((t) =>
    botReachesChannel({ mode: t.channelAccessMode, granted: t.granted, channelId: input.channel.id, openToBots })
  );
  if (receivers.length === 0) return 0;

  let data: Record<string, unknown>;
  if (input.event === 'message_delete') {
    data = { event: input.event, id: input.message.id, channelId: input.channel.id };
  } else {
    const author = await resolveAuthor(input.message);
    data = {
      event: input.event,
      message: {
        id: input.message.id,
        channelId: input.channel.id,
        content: input.message.content ?? '',
        author,
        createdAt: input.message.createdAt ?? null,
        ...(input.message.editedAt ? { editedAt: input.message.editedAt } : {}),
        ...(input.message.replyToId ? { replyToId: input.message.replyToId } : {}),
      },
    };
  }
  const channelId = input.channel.id;
  for (const target of receivers) {
    enqueueDelivery({
      botId: target.botId,
      serverId: input.serverId,
      event: input.event,
      data,
      authorize: async (bot: BotRow) =>
        botHasPermission(bot, 'read_messages') && (await botCanAccessChannel(bot, channelId)) !== null,
    });
  }
  return receivers.length;
}

/**
 * A message was created, edited or deleted: queue endpoint deliveries for
 * the bots that subscribed. Fire-and-forget — never fails the request.
 */
export function emitMessageEvent(input: MessageEventInput): void {
  void emitMessageEventNow(input).catch((err) =>
    console.warn('[bot-events] message event not dispatched:', (err as Error).message)
  );
}

// ── member events ───────────────────────────────────────────────────────

export interface MemberEventInput {
  serverId: string;
  userId: string;
  event: 'member_join' | 'member_leave';
  /** Why a member left (additive to §4.2). */
  reason?: 'leave' | 'kick' | 'ban';
  /** Display name when the caller has it (a departed user is still in `users`). */
  displayName?: string | null;
}

async function emitMemberEventNow(input: MemberEventInput): Promise<number> {
  const targets = await getBotEventTargets(input.serverId);
  const listeners = targets.filter((t) => t.permissions.includes('read_members') && t.permissions.includes('receive_events'));
  if (listeners.length === 0) return 0;
  const displayName =
    input.displayName !== undefined ? input.displayName : ((await getUserById(getDb(), input.userId))?.displayName ?? null);
  const data: Record<string, unknown> & { event: BotEventName } = {
    event: input.event,
    member: { id: input.userId, displayName },
    ...(input.reason ? { reason: input.reason } : {}),
  };
  for (const target of listeners) {
    void publishBotEvent(target.botId, data);
    if (wantsEndpointEvent(target, input.event)) {
      enqueueDelivery({
        botId: target.botId,
        serverId: input.serverId,
        event: input.event,
        data,
        authorize: (bot) => botHasPermission(bot, 'read_members'),
      });
    }
  }
  return listeners.length;
}

/** A member joined or left: tell the bots with `read_members`. Fire-and-forget. */
export function emitMemberEvent(input: MemberEventInput): void {
  void emitMemberEventNow(input).catch((err) =>
    console.warn('[bot-events] member event not dispatched:', (err as Error).message)
  );
}

// ── channel access changes (endpoints; the gateway re-sends on the stream) ─

export async function emitChannelAccessChanged(input: {
  serverId: string;
  botId: string;
  channels: Array<{ id: string; name: string }>;
}): Promise<void> {
  const targets = await getBotEventTargets(input.serverId);
  const target = targets.find((t) => t.botId === input.botId);
  if (!target || !wantsEndpointEvent(target, 'channel_access_changed')) return;
  enqueueDelivery({
    botId: input.botId,
    serverId: input.serverId,
    event: 'channel_access_changed',
    data: { event: 'channel_access_changed', channels: input.channels },
  });
}

/**
 * After a grant / revoke: the gateway recomputes the bot's stream (and
 * re-sends `channel_access_changed` there); the endpoint hears it here.
 */
export async function announceChannelAccessChange(bot: { id: string; serverId: string }): Promise<void> {
  notifyBotChanged({ serverId: bot.serverId, botId: bot.id, reason: 'channel_access_changed' });
  const channels = await listBotChannels(bot);
  await emitChannelAccessChanged({
    serverId: bot.serverId,
    botId: bot.id,
    channels: channels.map((c) => ({ id: c.id, name: c.name })),
  });
}

/** Dispatch a prepared job (interactions use this; exported for them). */
export function deliverToEndpoint(job: DeliveryJob): void {
  enqueueDelivery(job);
}

/** Test-only. */
export function __resetBotEventTargets(): void {
  targetCache.clear();
}

/** Test-only: the async part of `emitMessageEvent` (returns the receiver count). */
export const __emitMessageEventNow = emitMessageEventNow;
/** Test-only: the async part of `emitMemberEvent`. */
export const __emitMemberEventNow = emitMemberEventNow;
