import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getActiveChannelWebhook,
  getChannelById,
  touchChannelWebhookLastUsed,
  type ChannelWebhookRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import {
  distributedRateLimit,
  resolveClientAddress,
  withMachineApiSecurity,
  type RateLimitConfig,
  type RateLimitResult,
} from '@/lib/security-headers';
import { botApiRoute, botError } from '@/lib/bots/api';
import { toBotApiMessage } from '@/lib/bots/messages';
import { WebhookNameSchema, WEBHOOK_TOKEN_PATTERN, postWebhookMessage, verifyWebhookToken } from '@/lib/bots/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ webhookId: string; token: string }> };

/** Posts per webhook (§5.1) — keyed on the webhook once its token checks out. */
const WEBHOOK_POST_LIMIT: RateLimitConfig = { windowMs: 60_000, maxRequests: 30 };
/** Lookups per client address, before the database is touched. */
const WEBHOOK_ADDRESS_LIMIT: RateLimitConfig = { windowMs: 60_000, maxRequests: 120 };
/** Failed attempts (unknown id, wrong token, disabled) per client address. */
const WEBHOOK_FAILED_LIMIT: RateLimitConfig = { windowMs: 60_000, maxRequests: 30 };
const PATH = /^\/api\/webhooks\/([0-9a-fA-F-]{36})\/([^/]+)\/?$/;
const UUID = z.string().uuid();

/** Discord-style subset: unknown fields are ignored, not refused. */
const PostSchema = z.object({
  content: z.string(),
  username: WebhookNameSchema.optional(),
});

type Verdict =
  | { kind: 'ok'; webhook: ChannelWebhookRow }
  | { kind: 'denied' }
  | { kind: 'address_limited'; result: RateLimitResult };

const verdicts = new WeakMap<Request, Verdict>();

async function authenticate(req: Request): Promise<Verdict> {
  const match = PATH.exec(new URL(req.url).pathname);
  const webhookId = match?.[1];
  let token: string;
  try {
    token = decodeURIComponent(match?.[2] ?? '');
  } catch {
    return { kind: 'denied' };
  }
  if (!webhookId || !UUID.safeParse(webhookId).success || !WEBHOOK_TOKEN_PATTERN.test(token)) return { kind: 'denied' };
  const perAddress = await distributedRateLimit(`webhook-addr:${resolveClientAddress(req)}`, WEBHOOK_ADDRESS_LIMIT);
  if (!perAddress.allowed) return { kind: 'address_limited', result: perAddress };
  const webhook = await getActiveChannelWebhook(getDb(), webhookId.toLowerCase());
  // Always hash + compare, found or not, so timing says nothing.
  const matches = verifyWebhookToken(token, webhook?.tokenHash);
  if (webhook && matches && webhook.enabled) return { kind: 'ok', webhook };
  return { kind: 'denied' };
}

/** The webhook's own budget once authenticated; the caller's address otherwise. */
async function webhookRateScope(req: Request): Promise<string | null> {
  const verdict = await authenticate(req);
  verdicts.set(req, verdict);
  return verdict.kind === 'ok' ? `webhook:${verdict.webhook.id}` : null;
}

function rateLimited(result: RateLimitResult): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  return botError(
    429,
    'rate_limited',
    'Rate limit exceeded',
    { retryAfter, resetAt: new Date(result.resetAt).toISOString() },
    { 'Retry-After': String(retryAfter) }
  );
}

const NOT_FOUND = () => botError(404, 'not_found', 'Unknown webhook');

/**
 * POST /api/webhooks/{webhookId}/{token}  { content, username? }
 * An external service posts into the webhook's channel (docs/BOT_API_V2.md
 * §5.1). No cookie, no Origin: the secret URL is the credential. A wrong
 * token, an unknown, disabled or deleted webhook all answer 404 alike.
 * `?wait=true` → `200 { message }`, else `204`. Content 1–4000 characters,
 * no `@everyone` / `@here`, the Moderation Bot's content rules apply.
 */
async function handlePost(req: Request, _ctx: RouteContext): Promise<NextResponse> {
  const verdict = verdicts.get(req) ?? (await authenticate(req));
  verdicts.delete(req);
  if (verdict.kind === 'address_limited') return rateLimited(verdict.result);
  if (verdict.kind === 'denied') {
    const gate = await distributedRateLimit(`webhook-failed:${resolveClientAddress(req)}`, WEBHOOK_FAILED_LIMIT);
    if (!gate.allowed) return rateLimited(gate);
    return NOT_FOUND();
  }
  const { webhook } = verdict;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return botError(400, 'invalid_request', 'Body must be JSON');
  }
  const parsed = PostSchema.safeParse(raw);
  if (!parsed.success) {
    return botError(400, 'invalid_request', 'Invalid request body', {
      issues: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)),
    });
  }

  // The channel still has to be a text channel of the webhook's server.
  const channel = await getChannelById(getDb(), webhook.channelId);
  if (!channel || channel.serverId !== webhook.serverId || !['text', 'announcement'].includes(channel.type)) {
    return NOT_FOUND();
  }

  try {
    const result = await postWebhookMessage({
      webhook,
      channel,
      content: parsed.data.content,
      ...(parsed.data.username ? { username: parsed.data.username } : {}),
    });
    if (!result.ok) return botError(result.status, result.code, result.error, result.extra);
    void touchChannelWebhookLastUsed(getDb(), webhook.id).catch(() => undefined);
    if (new URL(req.url).searchParams.get('wait') === 'true') {
      return NextResponse.json({ message: toBotApiMessage(result.message, new Map()) });
    }
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error('[webhooks] post failed:', (err as Error).message);
    return botError(500, 'internal_error', 'Internal error');
  }
}

export const POST = botApiRoute(
  withMachineApiSecurity(handlePost, {
    allowedMethods: ['POST'],
    rateLimit: { identifier: 'webhook-post', config: WEBHOOK_POST_LIMIT },
    rateScope: webhookRateScope,
    maxBodyBytes: 16 * 1024,
  })
);
