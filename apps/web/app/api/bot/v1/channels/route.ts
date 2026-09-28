import { NextResponse } from 'next/server';
import type { BotRow } from '@lobbyforge/db';
import { withMachineApiSecurity } from '@/lib/security-headers';
import { botApiOptions, botApiRoute, botError, withBotAuth } from '@/lib/bots/api';
import { listChannelsForBot } from '@/lib/bots/messages';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/bot/v1/channels — the text channels of the bot's server that
 * are open to bots (no role gate). Needs `read_messages` or `send_messages`.
 */
async function handleGet(_req: Request, _ctx: unknown, bot: BotRow): Promise<NextResponse> {
  const result = await listChannelsForBot(bot);
  if (!result.ok) return botError(result.status, result.code, result.error, result.extra);
  return NextResponse.json({ channels: result.value });
}

export const GET = botApiRoute(
  withMachineApiSecurity(withBotAuth(handleGet), botApiOptions(['GET'], 'channels', { windowMs: 60_000, maxRequests: 60 }))
);
