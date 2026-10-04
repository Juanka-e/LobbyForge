import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getChannelWebhookById, updateChannelWebhook } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { jsonErrors } from '@/lib/bots/admin';
import {
  auditWebhookAction,
  generateWebhookToken,
  requireWebhookManager,
  toWebhookJson,
  webhookPath,
  webhookPublicOrigin,
} from '@/lib/bots/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string; channelId: string; webhookId: string }> };

/**
 * POST …/webhooks/{webhookId}/token — rotate: a new secret URL, returned
 * once; the old URL stops working at once. Audited as `webhook.token.rotate`.
 */
async function handlePost(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, channelId, webhookId } = await ctx.params;
  const auth = await requireWebhookManager(req, serverId, channelId);
  if (!auth.ok) return auth.response;
  const existing = z.string().uuid().safeParse(webhookId).success ? await getChannelWebhookById(getDb(), webhookId) : null;
  if (!existing || existing.channelId !== auth.manager.channel.id) {
    return NextResponse.json({ error: 'Webhook not found', code: 'not_found' }, { status: 404 });
  }
  const { token, hash } = generateWebhookToken();
  const updated = await updateChannelWebhook(getDb(), existing.id, { tokenHash: hash });
  if (!updated) return NextResponse.json({ error: 'Webhook not found', code: 'not_found' }, { status: 404 });
  auditWebhookAction({ serverId, actorUserId: auth.manager.uid, action: 'webhook.token.rotate', webhook: updated });
  const path = webhookPath(updated.id, token);
  return NextResponse.json(
    { webhook: toWebhookJson(updated), token, path, url: `${webhookPublicOrigin(req)}${path}` },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const POST = withApiSecurity(jsonErrors('rotate webhook token', handlePost), {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'channel-webhooks-rotate', config: { windowMs: 60_000, maxRequests: 10 } },
});
