import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { countChannelWebhooks, createChannelWebhook, listChannelWebhooks } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { invalidBody, jsonErrors } from '@/lib/bots/admin';
import { MAX_WEBHOOKS_PER_CHANNEL } from '@/lib/bots/catalog';
import {
  WebhookNameSchema,
  auditWebhookAction,
  generateWebhookToken,
  requireWebhookManager,
  toWebhookJson,
  webhookPath,
  webhookPublicOrigin,
} from '@/lib/bots/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string; channelId: string }> };

const CreateSchema = z.object({ name: WebhookNameSchema }).strict();
const noStore = { headers: { 'Cache-Control': 'no-store' } };

/**
 * GET /api/servers/{id}/channels/{channelId}/webhooks — the channel's
 * incoming webhooks (never a token or its hash). Needs Manage Channels.
 */
async function handleGet(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, channelId } = await ctx.params;
  const auth = await requireWebhookManager(req, serverId, channelId);
  if (!auth.ok) return auth.response;
  const rows = await listChannelWebhooks(getDb(), auth.manager.channel.id);
  return NextResponse.json({ webhooks: rows.map(toWebhookJson) }, noStore);
}

/**
 * POST /api/servers/{id}/channels/{channelId}/webhooks  { name }
 * → `201 { webhook, token, url }` — the only time the token (and the URL
 * that contains it) is returned. At most 10 per channel. Audited as
 * `webhook.create`.
 */
async function handlePost(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, channelId } = await ctx.params;
  const auth = await requireWebhookManager(req, serverId, channelId);
  if (!auth.ok) return auth.response;
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidBody(parsed.error.issues);
  const { channel } = auth.manager;
  if ((await countChannelWebhooks(getDb(), channel.id)) >= MAX_WEBHOOKS_PER_CHANNEL) {
    return NextResponse.json(
      { error: `A channel can have at most ${MAX_WEBHOOKS_PER_CHANNEL} webhooks`, code: 'webhook_limit_reached', max: MAX_WEBHOOKS_PER_CHANNEL },
      { status: 409 }
    );
  }
  const { token, hash } = generateWebhookToken();
  const webhook = await createChannelWebhook(getDb(), {
    id: randomUUID(),
    serverId,
    channelId: channel.id,
    name: parsed.data.name,
    tokenHash: hash,
    createdBy: auth.manager.uid,
  });
  auditWebhookAction({ serverId, actorUserId: auth.manager.uid, action: 'webhook.create', webhook });
  const path = webhookPath(webhook.id, token);
  return NextResponse.json(
    { webhook: toWebhookJson(webhook), token, path, url: `${webhookPublicOrigin(req)}${path}` },
    { status: 201, headers: { 'Cache-Control': 'no-store' } }
  );
}

export const GET = withApiSecurity(jsonErrors('list webhooks', handleGet), {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'channel-webhooks-list', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const POST = withApiSecurity(jsonErrors('create webhook', handlePost), {
  allowedMethods: ['POST'],
  maxBodyBytes: 1024,
  rateLimit: { identifier: 'channel-webhooks-create', config: { windowMs: 60_000, maxRequests: 10 } },
});
