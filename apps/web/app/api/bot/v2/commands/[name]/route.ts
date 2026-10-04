import { NextResponse } from 'next/server';
import { deleteBotCommandByName, type BotRow } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withMachineApiSecurity } from '@/lib/security-headers';
import { botApiOptions, botApiRoute, botError, withBotAuth } from '@/lib/bots/api';
import { COMMAND_NAME_PATTERN } from '@/lib/bots/catalog';
import { V2_READ_LIMIT, requireBotPermission } from '../../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ name: string }> };

/** DELETE /api/bot/v2/commands/{name} — remove one of this bot's commands. */
async function handleDelete(_req: Request, ctx: RouteContext, bot: BotRow): Promise<NextResponse> {
  const denied = requireBotPermission(bot, 'slash_commands');
  if (denied) return denied;
  const { name } = await ctx.params;
  if (!COMMAND_NAME_PATTERN.test(name) || !(await deleteBotCommandByName(getDb(), bot.id, name))) {
    return botError(404, 'not_found', 'Command not found');
  }
  return NextResponse.json({ ok: true });
}

export const DELETE = botApiRoute(
  withMachineApiSecurity(withBotAuth(handleDelete), botApiOptions(['DELETE'], 'v2-commands-delete', V2_READ_LIMIT))
);
