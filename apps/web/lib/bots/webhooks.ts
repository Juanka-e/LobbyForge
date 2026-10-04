/**
 * Incoming channel webhooks (docs/BOT_API_V2.md §5.1).
 *
 *   URL:   https://<instance>/api/webhooks/{webhookId}/{token}
 *   token: lfw_<43 base64url characters> — 256 random bits, shown ONCE.
 *
 * Only `sha256$<hex>` of the token is stored (domain-separated from bot
 * tokens), compared in constant time; a fast hash is right for a 256-bit
 * random secret. The `lfw_` prefix lets secret scanners and log filters
 * spot a leaked URL.
 *
 * A post is stored like a member's message — same table, same realtime
 * fan-out, same audit entry, same Moderation Bot — but with `user_id` and
 * `bot_id` NULL and a `metadata.webhook` snapshot `{ id, name, username? }`
 * (the `webhook` metadata key is reserved: members cannot set it). A
 * webhook is not a member, so timeouts and bans do not apply; mass
 * mentions are refused outright.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CorePermission } from '@lobbyforge/core';
import {
  createWebhookMessage,
  getChannelById,
  getServerById,
  logAction,
  type ChannelRow,
  type ChannelWebhookRow,
  type MessageRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { publishChatMessage } from '@/lib/chat-bus';
import { requireMaterializedSession, type ApiResult } from '@/lib/api-auth';
import { authorizeChannelVisibility, authorizeServerPermission } from '@/lib/permissions';
import { MAX_BOT_MESSAGE_LENGTH, WEBHOOK_NAME_MAX_LENGTH } from './catalog';
import { emitMessageEvent } from './events';
import { moderateWebhookMessage, moderationBlockedBody } from './moderation';
import { containsMassMention } from './settings';

export const WEBHOOK_TOKEN_PATTERN = /^lfw_[A-Za-z0-9_-]{43}$/;
const HASH_PREFIX = 'sha256$';
const HASH_CONTEXT = 'lobbyforge:webhook-token:v1\n';
/** Compared against when the webhook does not exist, so every path hashes + compares. */
const ABSENT_HASH = `${HASH_PREFIX}${'0'.repeat(64)}`;

export function hashWebhookToken(token: string): string {
  return `${HASH_PREFIX}${createHash('sha256').update(HASH_CONTEXT).update(token, 'utf8').digest('hex')}`;
}

/** A new token; give `token` to the admin once, store only `hash`. */
export function generateWebhookToken(): { token: string; hash: string } {
  const token = `lfw_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashWebhookToken(token) };
}

/** Constant-time check of a presented token against the stored hash. */
export function verifyWebhookToken(token: string, storedHash: string | null | undefined): boolean {
  const stored = storedHash && storedHash.startsWith(HASH_PREFIX) ? storedHash : ABSENT_HASH;
  const expected = Buffer.from(stored.slice(HASH_PREFIX.length), 'hex');
  const actual = Buffer.from(hashWebhookToken(token).slice(HASH_PREFIX.length), 'hex');
  if (expected.length !== 32 || actual.length !== 32) return false;
  const same = timingSafeEqual(expected, actual);
  return same && stored !== ABSENT_HASH && WEBHOOK_TOKEN_PATTERN.test(token);
}

/** Where the instance is reached from outside, for the URL shown once. */
export function webhookPublicOrigin(req: Request): string {
  const candidates = [process.env.LOBBYFORGE_APP_ORIGIN, process.env.NEXT_PUBLIC_BASE_URL, req.headers.get('origin') ?? undefined];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return new URL(candidate).origin;
    } catch {
      /* try the next one */
    }
  }
  return new URL(req.url).origin;
}

export function webhookPath(webhookId: string, token: string): string {
  return `/api/webhooks/${webhookId}/${token}`;
}

/**
 * Characters a display name must not carry: controls (Cc), invisible
 * formatting (Cf — zero-width characters, bidi embeddings / overrides /
 * isolates U+202A–202E and U+2066–2069, U+061C, U+180E, U+FEFF, …) and line /
 * paragraph separators (Zl, Zp). Escapes only: a literal invisible
 * character in source is unreviewable.
 */
const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A webhook's (or a post's display) name: 1–32 characters, whitespace collapsed, no control characters. */
export const WebhookNameSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(1, 'Name is required')
      .max(WEBHOOK_NAME_MAX_LENGTH, `Name must be at most ${WEBHOOK_NAME_MAX_LENGTH} characters`)
      .refine((value) => !INVISIBLE_OR_CONTROL.test(value), 'Name must not contain control characters')
  );

/** Never includes the token hash. */
export function toWebhookJson(row: ChannelWebhookRow) {
  return {
    id: row.id,
    serverId: row.serverId,
    channelId: row.channelId,
    name: row.name,
    enabled: row.enabled,
    createdBy: row.createdBy ? { id: row.createdBy, name: row.createdByName } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

const WEBHOOK_CHANNEL_TYPES: ReadonlySet<string> = new Set(['text', 'announcement']);

export interface WebhookManager {
  uid: string;
  server: { id: string; ownerUserId: string };
  channel: ChannelRow;
}

/**
 * Managing a channel's webhooks (§1.3): a signed-in member holding
 * MANAGE_CHANNELS (owner / administrators implied) who can see the channel;
 * the channel must be a text or announcement channel of this server.
 */
export async function requireWebhookManager(
  req: Request,
  serverId: string,
  channelId: string
): Promise<ApiResult<{ manager: WebhookManager }>> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session;
  const uid = session.session.uid;
  const server = await getServerById(getDb(), serverId);
  if (!server) return { ok: false, response: NextResponse.json({ error: 'Server not found', code: 'not_found' }, { status: 404 }) };
  const auth = await authorizeServerPermission(uid, serverId, CorePermission.MANAGE_CHANNELS);
  if (!auth.ok) return { ok: false, response: auth.response };
  const channel = z.string().uuid().safeParse(channelId).success ? await getChannelById(getDb(), channelId) : null;
  if (!channel || channel.serverId !== serverId) {
    return { ok: false, response: NextResponse.json({ error: 'Channel not found', code: 'not_found' }, { status: 404 }) };
  }
  const visible = await authorizeChannelVisibility(uid, serverId, channelId, server.ownerUserId);
  if (!visible.ok) return { ok: false, response: visible.response };
  if (!WEBHOOK_CHANNEL_TYPES.has(channel.type)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Webhooks post into text or announcement channels', code: 'invalid_channel' }, { status: 400 }),
    };
  }
  return { ok: true, manager: { uid, server: { id: server.id, ownerUserId: server.ownerUserId }, channel } };
}

/** One audit row per webhook change. Never carries the token or its hash. */
export function auditWebhookAction(input: {
  serverId: string;
  actorUserId: string;
  action: string;
  webhook: Pick<ChannelWebhookRow, 'id' | 'name' | 'channelId'>;
  metadata?: Record<string, unknown>;
}): void {
  void logAction(getDb(), {
    serverId: input.serverId,
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: 'webhook',
    targetId: input.webhook.id,
    metadata: { name: input.webhook.name, channelId: input.webhook.channelId, ...(input.metadata ?? {}) },
  }).catch((err) => console.error(`[audit] ${input.action} failed:`, (err as Error).message));
}

export type WebhookPostResult =
  | { ok: true; message: MessageRow }
  | { ok: false; status: number; code: string; error: string; extra?: Record<string, unknown> };

/**
 * Post into the webhook's channel. The caller has authenticated the
 * webhook and checked the channel; this runs the content rules and writes.
 */
export async function postWebhookMessage(input: {
  webhook: ChannelWebhookRow;
  channel: ChannelRow;
  content: string;
  username?: string;
}): Promise<WebhookPostResult> {
  const { webhook, channel } = input;
  const content = input.content.trim();
  if (!content || content.length > MAX_BOT_MESSAGE_LENGTH) {
    return { ok: false, status: 400, code: 'invalid_request', error: `content must be 1–${MAX_BOT_MESSAGE_LENGTH} characters` };
  }
  if (containsMassMention(content)) {
    return { ok: false, status: 403, code: 'mass_mention_forbidden', error: 'Webhooks cannot mention @everyone or @here' };
  }
  const displayName = input.username ?? webhook.name;
  const verdict = await moderateWebhookMessage({
    serverId: webhook.serverId,
    channelId: channel.id,
    webhook: { id: webhook.id, name: displayName },
    content,
  });
  if (verdict.action === 'block') {
    const body = moderationBlockedBody(verdict);
    return { ok: false, status: 422, code: body.code, error: body.error, extra: { rule: body.rule, bot: body.bot } };
  }

  const snapshot = { id: webhook.id, name: webhook.name, ...(input.username ? { username: input.username } : {}) };
  const created = await createWebhookMessage(getDb(), { channelId: channel.id, content, metadata: { webhook: snapshot } });
  publishChatMessage({
    serverId: webhook.serverId,
    channelId: channel.id,
    message: {
      id: created.id,
      channelId: created.channelId,
      userId: null,
      botId: null,
      bot: null,
      content: created.content,
      metadata: created.metadata,
      replyToId: null,
      createdAt: created.createdAt.toISOString(),
    },
  });
  void logAction(getDb(), {
    serverId: webhook.serverId,
    actorUserId: null,
    action: 'message.create',
    targetType: 'message',
    targetId: created.id,
    metadata: { channelId: channel.id, webhookId: webhook.id, webhookName: webhook.name },
  }).catch((err) => console.error('[audit] webhook message.create failed:', (err as Error).message));
  emitMessageEvent({
    serverId: webhook.serverId,
    channel: { id: channel.id, type: channel.type },
    event: 'message_create',
    message: {
      id: created.id,
      content: created.content,
      createdAt: created.createdAt.toISOString(),
      webhook: { id: webhook.id, name: displayName },
    },
  });
  return { ok: true, message: created };
}
