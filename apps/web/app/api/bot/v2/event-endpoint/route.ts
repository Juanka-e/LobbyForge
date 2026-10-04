import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  deleteBotEventEndpoint,
  getBotEventEndpoint,
  logAction,
  upsertBotEventEndpoint,
  type BotRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withMachineApiSecurity } from '@/lib/security-headers';
import { botApiOptions, botApiRoute, botError, readJsonBody, withBotAuth } from '@/lib/bots/api';
import { BOT_EVENT_NAMES } from '@/lib/bots/catalog';
import {
  EVENT_ENDPOINT_URL_MAX_LENGTH,
  defaultEndpointEvents,
  generateEndpointSecret,
  toEventEndpointJson,
  validateEndpointUrl,
} from '@/lib/bots/event-delivery';
import { invalidateBotEventTargets } from '@/lib/bots/events';
import { V2_ENDPOINT_WRITE_LIMIT, V2_READ_LIMIT, invalidRequest, requireBotPermission } from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PutEndpointSchema = z
  .object({
    url: z.string().min(1).max(EVENT_ENDPOINT_URL_MAX_LENGTH),
    events: z.array(z.enum(BOT_EVENT_NAMES)).min(1).max(BOT_EVENT_NAMES.length).optional(),
  })
  .strict();

function audit(bot: BotRow, action: string, metadata: Record<string, unknown>): void {
  void logAction(getDb(), {
    serverId: bot.serverId,
    actorUserId: null,
    action,
    targetType: 'bot',
    targetId: bot.id,
    metadata: { botName: bot.name, ...metadata },
  }).catch((err) => console.error(`[audit] ${action} failed:`, (err as Error).message));
}

/** GET /api/bot/v2/event-endpoint — the endpoint's status (never the secret), or null. */
async function handleGet(_req: Request, _ctx: unknown, bot: BotRow): Promise<NextResponse> {
  const denied = requireBotPermission(bot, 'receive_events');
  if (denied) return denied;
  const row = await getBotEventEndpoint(getDb(), bot.id);
  return NextResponse.json({ endpoint: row ? toEventEndpointJson(row) : null });
}

/**
 * PUT /api/bot/v2/event-endpoint  { url, events? }
 * Set or replace the HTTPS endpoint. The URL must resolve only to public
 * addresses (checked now and on every delivery). Every PUT issues a NEW
 * signing secret, returned in this response only; saving also re-arms an
 * endpoint that was switched off. `events` defaults to everything the
 * bot's permissions allow.
 */
async function handlePut(req: Request, _ctx: unknown, bot: BotRow): Promise<NextResponse> {
  const denied = requireBotPermission(bot, 'receive_events');
  if (denied) return denied;
  const json = await readJsonBody(req);
  if (!json.ok) return json.response;
  const parsed = PutEndpointSchema.safeParse(json.body);
  if (!parsed.success) return invalidRequest(parsed.error);

  const verdict = await validateEndpointUrl(parsed.data.url);
  if (!verdict.ok) return botError(400, 'invalid_endpoint', verdict.reason);

  const events = parsed.data.events ? Array.from(new Set(parsed.data.events)) : defaultEndpointEvents(bot.permissions);
  const secret = generateEndpointSecret();
  const row = await upsertBotEventEndpoint(getDb(), { botId: bot.id, url: verdict.url, events, secret });
  invalidateBotEventTargets(bot.serverId);
  audit(bot, 'bot.event_endpoint.set', { host: verdict.hostname, events });
  return NextResponse.json({ endpoint: toEventEndpointJson(row), secret });
}

/** DELETE /api/bot/v2/event-endpoint — stop deliveries and forget the secret. */
async function handleDelete(_req: Request, _ctx: unknown, bot: BotRow): Promise<NextResponse> {
  const denied = requireBotPermission(bot, 'receive_events');
  if (denied) return denied;
  if (!(await deleteBotEventEndpoint(getDb(), bot.id))) return botError(404, 'not_found', 'No event endpoint is set');
  invalidateBotEventTargets(bot.serverId);
  audit(bot, 'bot.event_endpoint.remove', {});
  return NextResponse.json({ ok: true });
}

export const GET = botApiRoute(
  withMachineApiSecurity(withBotAuth(handleGet), botApiOptions(['GET'], 'v2-event-endpoint-get', V2_READ_LIMIT))
);

export const PUT = botApiRoute(
  withMachineApiSecurity(
    withBotAuth(handlePut),
    botApiOptions(['PUT'], 'v2-event-endpoint-write', V2_ENDPOINT_WRITE_LIMIT, 4 * 1024)
  )
);

export const DELETE = botApiRoute(
  withMachineApiSecurity(withBotAuth(handleDelete), botApiOptions(['DELETE'], 'v2-event-endpoint-write', V2_ENDPOINT_WRITE_LIMIT))
);
