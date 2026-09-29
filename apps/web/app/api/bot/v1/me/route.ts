import { NextResponse } from 'next/server';
import type { BotRow } from '@lobbyforge/db';
import { withMachineApiSecurity } from '@/lib/security-headers';
import { botApiOptions, botApiRoute, withBotAuth } from '@/lib/bots/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/bot/v1/me — who this token belongs to. No permission needed. */
async function handleGet(_req: Request, _ctx: unknown, bot: BotRow): Promise<NextResponse> {
  return NextResponse.json({
    bot: {
      id: bot.id,
      name: bot.name,
      type: bot.type,
      serverId: bot.serverId,
      permissions: bot.permissions,
    },
  });
}

export const GET = botApiRoute(
  withMachineApiSecurity(withBotAuth(handleGet), botApiOptions(['GET'], 'me', { windowMs: 60_000, maxRequests: 60 }))
);
