import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteBotEventEndpoint, getBotById, getBotEventEndpoint, reenableBotEventEndpoint, type BotRow } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { auditBotAction, invalidBody, jsonErrors, requireBotManager } from '@/lib/bots/admin';
import { toEventEndpointJson } from '@/lib/bots/event-delivery';
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

/**
 * PATCH …/event-endpoint  { enabled: true } — switch an endpoint that was
 * disabled after repeated failures back on (counter reset). The URL and
 * secret are the bot's to set (Bot API `PUT /event-endpoint`).
 */
async function handlePatch(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, botId } = await ctx.params;
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return auth.response;
  const bot = await loadServerBot(serverId, botId);
  if (!bot) return NOT_FOUND('Bot');
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidBody(parsed.error.issues);
  const row = await reenableBotEventEndpoint(getDb(), bot.id);
  if (!row) return NOT_FOUND('Event endpoint');
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
