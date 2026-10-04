import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteChannelWebhook, getChannelWebhookById, updateChannelWebhook, type ChannelWebhookRow } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { invalidBody, jsonErrors } from '@/lib/bots/admin';
import { WebhookNameSchema, auditWebhookAction, requireWebhookManager, toWebhookJson } from '@/lib/bots/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string; channelId: string; webhookId: string }> };

const PatchSchema = z
  .object({ name: WebhookNameSchema, enabled: z.boolean() })
  .strict()
  .partial()
  .refine((value) => value.name !== undefined || value.enabled !== undefined, 'Nothing to change');

const noStore = { headers: { 'Cache-Control': 'no-store' } };
const NOT_FOUND = () => NextResponse.json({ error: 'Webhook not found', code: 'not_found' }, { status: 404 });

/** The webhook, only if it belongs to this channel (and so this server). */
async function loadChannelWebhook(channelId: string, webhookId: string): Promise<ChannelWebhookRow | null> {
  if (!z.string().uuid().safeParse(webhookId).success) return null;
  const row = await getChannelWebhookById(getDb(), webhookId);
  return row && row.channelId === channelId ? row : null;
}

/**
 * PATCH …/webhooks/{webhookId}  { name?, enabled? } — rename, or switch
 * off / on (a disabled webhook's URL answers 404). Audited as
 * `webhook.update` / `webhook.enable` / `webhook.disable`.
 */
async function handlePatch(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, channelId, webhookId } = await ctx.params;
  const auth = await requireWebhookManager(req, serverId, channelId);
  if (!auth.ok) return auth.response;
  const webhook = await loadChannelWebhook(auth.manager.channel.id, webhookId);
  if (!webhook) return NOT_FOUND();
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidBody(parsed.error.issues);
  const patch: { name?: string; enabled?: boolean } = {};
  if (parsed.data.name !== undefined && parsed.data.name !== webhook.name) patch.name = parsed.data.name;
  if (parsed.data.enabled !== undefined && parsed.data.enabled !== webhook.enabled) patch.enabled = parsed.data.enabled;
  if (Object.keys(patch).length === 0) return NextResponse.json({ webhook: toWebhookJson(webhook) }, noStore);
  const updated = await updateChannelWebhook(getDb(), webhook.id, patch);
  if (!updated) return NOT_FOUND();
  const onlyToggle = patch.enabled !== undefined && patch.name === undefined;
  auditWebhookAction({
    serverId,
    actorUserId: auth.manager.uid,
    action: onlyToggle ? (patch.enabled ? 'webhook.enable' : 'webhook.disable') : 'webhook.update',
    webhook: updated,
    metadata: onlyToggle ? {} : { changes: { ...(patch.name ? { name: { from: webhook.name, to: patch.name } } : {}), ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) } },
  });
  return NextResponse.json({ webhook: toWebhookJson(updated) }, noStore);
}

/** DELETE …/webhooks/{webhookId} — its URL stops working at once; past posts stay. */
async function handleDelete(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, channelId, webhookId } = await ctx.params;
  const auth = await requireWebhookManager(req, serverId, channelId);
  if (!auth.ok) return auth.response;
  const webhook = await loadChannelWebhook(auth.manager.channel.id, webhookId);
  if (!webhook) return NOT_FOUND();
  if (!(await deleteChannelWebhook(getDb(), webhook.id))) return NOT_FOUND();
  auditWebhookAction({ serverId, actorUserId: auth.manager.uid, action: 'webhook.delete', webhook });
  return NextResponse.json({ ok: true }, noStore);
}

export const PATCH = withApiSecurity(jsonErrors('update webhook', handlePatch), {
  allowedMethods: ['PATCH'],
  maxBodyBytes: 1024,
  rateLimit: { identifier: 'channel-webhooks-update', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const DELETE = withApiSecurity(jsonErrors('delete webhook', handleDelete), {
  allowedMethods: ['DELETE'],
  rateLimit: { identifier: 'channel-webhooks-delete', config: { windowMs: 60_000, maxRequests: 30 } },
});
