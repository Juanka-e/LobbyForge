import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  ENDPOINT_DISABLED_TOKEN_CHANGED,
  deleteBotEventEndpoint,
  getBotById,
  getBotEventEndpoint,
  reenableBotEventEndpoint,
  type BotRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { auditBotAction, invalidBody, jsonErrors, requireBotManager } from '@/lib/bots/admin';
import { resetEndpointBackoff, toEventEndpointJson } from '@/lib/bots/event-delivery';
import { invalidateBotEventTargets } from '@/lib/bots/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string; botId: string }> };

const PatchSchema = z.object({ enabled: z.literal(true) }).strict();
const noStore = { headers: { 'Cache-Control': 'no-store' } };
const NOT_FOUND = (what: string) => NextResponse.json({ error: `${what} not found`, code: 'not_found' }, { status: 404 });

async function loadServerBot(serverId: string, botId: string): Promise<BotRow | null> {
  if (!z.string().uuid().safeParse(botId).success) return null;
  const bot = await getBotById(getDb(), botId);
  return bot && bot.serverId === serverId ? bot : null;
}

/**
 * GET /api/servers/{id}/bots/{botId}/event-endpoint — the bot's outgoing
 * endpoint as its managers see it: URL, events, enabled, failures, last
 * delivery — never the signing secret. `{ endpoint: null }` when unset.
 * Needs Manage Community (the same right as managing the bot, §1.3).
 */
async function handleGet(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, botId } = await ctx.params;
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return auth.response;
  const bot = await loadServerBot(serverId, botId);
  if (!bot) return NOT_FOUND('Bot');
  const row = await getBotEventEndpoint(getDb(), bot.id);
  return NextResponse.json({ endpoint: row ? toEventEndpointJson(row) : null }, noStore);
}

const TOKEN_CHANGED = () =>
  NextResponse.json(
    {
      error: 'This endpoint was switched off because the bot token changed; the bot must set it again with its new token',
      code: 'endpoint_token_changed',
    },
    { status: 409 }
  );

/**
 * PATCH …/event-endpoint  { enabled: true } — switch an endpoint that was
 * disabled after repeated failures back on (counter reset). The URL and
 * secret are the bot's to set (Bot API `PUT /event-endpoint`) — so an
 * endpoint switched off by a token rotate / revoke (`token_changed`) is
 * NOT re-enabled here: whoever held the old token chose its URL and knows
 * its secret (BOT-002). 409 `endpoint_token_changed`; remove it instead.
 */
async function handlePatch(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, botId } = await ctx.params;
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return auth.response;
  const bot = await loadServerBot(serverId, botId);
  if (!bot) return NOT_FOUND('Bot');
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidBody(parsed.error.issues);
  const current = await getBotEventEndpoint(getDb(), bot.id);
  if (!current) return NOT_FOUND('Event endpoint');
  if (current.disabledReason === ENDPOINT_DISABLED_TOKEN_CHANGED) return TOKEN_CHANGED();
  // The query refuses a token_changed endpoint too (a rotation in between).
  const row = await reenableBotEventEndpoint(getDb(), bot.id);
  if (!row) return (await getBotEventEndpoint(getDb(), bot.id)) ? TOKEN_CHANGED() : NOT_FOUND('Event endpoint');
  resetEndpointBackoff(bot.id);
  invalidateBotEventTargets(serverId);
  auditBotAction({ serverId, actorUserId: auth.manager.uid, action: 'bot.event_endpoint.enable', bot });
  return NextResponse.json({ endpoint: toEventEndpointJson(row) }, noStore);
}

/** DELETE …/event-endpoint — remove the bot's endpoint (deliveries stop at once). */
async function handleDelete(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, botId } = await ctx.params;
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return auth.response;
  const bot = await loadServerBot(serverId, botId);
  if (!bot) return NOT_FOUND('Bot');
  if (!(await deleteBotEventEndpoint(getDb(), bot.id))) return NOT_FOUND('Event endpoint');
  resetEndpointBackoff(bot.id);
  invalidateBotEventTargets(serverId);
  auditBotAction({ serverId, actorUserId: auth.manager.uid, action: 'bot.event_endpoint.remove', bot });
  return NextResponse.json({ ok: true }, noStore);
}

export const GET = withApiSecurity(jsonErrors('bot event endpoint', handleGet), {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'server-bots-endpoint-get', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const PATCH = withApiSecurity(jsonErrors('re-enable bot event endpoint', handlePatch), {
  allowedMethods: ['PATCH'],
  maxBodyBytes: 1024,
  rateLimit: { identifier: 'server-bots-endpoint-write', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const DELETE = withApiSecurity(jsonErrors('remove bot event endpoint', handleDelete), {
  allowedMethods: ['DELETE'],
  rateLimit: { identifier: 'server-bots-endpoint-write', config: { windowMs: 60_000, maxRequests: 30 } },
});
