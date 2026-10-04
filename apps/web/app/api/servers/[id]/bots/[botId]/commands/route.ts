import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getBotById, listBotCommands } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { jsonErrors, requireBotManager } from '@/lib/bots/admin';
import { toAdminCommandJson } from '@/lib/bots/commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string; botId: string }> };

/**
 * GET /api/servers/{id}/bots/{botId}/commands — the commands a bot
 * registered, for Admin → Bots (read-only except the manager switches on
 * `…/commands/{commandId}`). Needs Manage Community.
 */
async function handleGet(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, botId } = await ctx.params;
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return auth.response;
  const bot = z.string().uuid().safeParse(botId).success ? await getBotById(getDb(), botId) : null;
  if (!bot || bot.serverId !== serverId) {
    return NextResponse.json({ error: 'Bot not found', code: 'not_found' }, { status: 404 });
  }
  const rows = await listBotCommands(getDb(), bot.id);
  return NextResponse.json({ commands: rows.map(toAdminCommandJson) }, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withApiSecurity(jsonErrors('list bot commands', handleGet), {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'server-bots-commands-list', config: { windowMs: 60_000, maxRequests: 60 } },
});
