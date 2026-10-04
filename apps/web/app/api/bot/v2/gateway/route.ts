import { NextResponse } from 'next/server';
import type { BotRow } from '@lobbyforge/db';
import { withMachineApiSecurity } from '@/lib/security-headers';
import { botApiOptions, botApiRoute, withBotAuth } from '@/lib/bots/api';
import { getRuntimeRealtimeUrl } from '@/lib/public-endpoints';
import { V2_READ_LIMIT, requireBotPermission } from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BOT_GATEWAY_PATH = '/ws/bot';
/** The gateway's own port on a plain-HTTP dev box (same fallback the browser uses). */
const DEV_GATEWAY_PORT = 19521;

/**
 * Where bots open the event stream (docs/BOT_API_V2.md §4.1):
 *   1. `LOBBYFORGE_PUBLIC_BOT_GATEWAY_URL`, verbatim;
 *   2. the browsers' realtime URL (`LOBBYFORGE_PUBLIC_WS_URL`) with the bot
 *      path — `wss://host/ws` → `wss://host/ws/bot` (nginx's `/ws` prefix
 *      location already forwards it), `ws://host:19521` → `…/ws/bot`;
 *   3. same origin: `wss://<host>/ws/bot` behind HTTPS, the sibling dev
 *      port on plain HTTP.
 */
function botGatewayUrl(req: Request): string {
  const override = process.env.LOBBYFORGE_PUBLIC_BOT_GATEWAY_URL?.trim();
  if (override) return override;
  const realtime = getRuntimeRealtimeUrl();
  if (realtime) {
    try {
      const url = new URL(realtime);
      const path = url.pathname.replace(/\/+$/, '');
      url.pathname = path.endsWith('/ws') ? `${path}/bot` : `${path}${BOT_GATEWAY_PATH}`;
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      /* fall through to the request origin */
    }
  }
  const origin = new URL(req.url);
  if (origin.protocol === 'https:') return `wss://${origin.host}${BOT_GATEWAY_PATH}`;
  return `ws://${origin.hostname}:${DEV_GATEWAY_PORT}${BOT_GATEWAY_PATH}`;
}

/** GET /api/bot/v2/gateway — `{ url }` of the event stream. Needs `receive_events`. */
async function handleGet(req: Request, _ctx: unknown, bot: BotRow): Promise<NextResponse> {
  const denied = requireBotPermission(bot, 'receive_events');
  if (denied) return denied;
  return NextResponse.json({ url: botGatewayUrl(req) });
}

export const GET = botApiRoute(
  withMachineApiSecurity(withBotAuth(handleGet), botApiOptions(['GET'], 'v2-gateway', V2_READ_LIMIT))
);
