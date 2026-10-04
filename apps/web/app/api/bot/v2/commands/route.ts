import { NextResponse } from 'next/server';
import {
  CommandNameTakenError,
  findCommandNamesTakenByOtherBots,
  listBotCommands,
  replaceBotCommands,
  type BotRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withMachineApiSecurity } from '@/lib/security-headers';
import { botApiOptions, botApiRoute, botError, readJsonBody, withBotAuth } from '@/lib/bots/api';
import { listBotChannels } from '@/lib/bots/access';
import { CommandListSchema, normalizeCommandOptions, toBotCommandJson } from '@/lib/bots/commands';
import { sweepExpiredInteractions } from '@/lib/bots/interactions';
import { V2_COMMANDS_PUT_LIMIT, V2_READ_LIMIT, invalidRequest, requireBotPermission } from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 50 commands × 25 options × 25 choices fits comfortably. */
const MAX_COMMANDS_BODY_BYTES = 256 * 1024;

/**
 * GET /api/bot/v2/commands — this bot's registered commands. Needs
 * `slash_commands`. Also sweeps the bot's overdue interactions to
 * `expired` (lazy expiry, docs/BOT_API_V2.md §3.4).
 */
async function handleGet(_req: Request, _ctx: unknown, bot: BotRow): Promise<NextResponse> {
  const denied = requireBotPermission(bot, 'slash_commands');
  if (denied) return denied;
  await sweepExpiredInteractions(bot.id);
  const rows = await listBotCommands(getDb(), bot.id);
  return NextResponse.json({ commands: rows.map(toBotCommandJson) });
}

/**
 * PUT /api/bot/v2/commands — bulk overwrite (≤ 50). Body: the full list,
 * as a JSON array or `{ commands: [...] }`. Names another bot of this
 * server owns → 409 `command_name_taken` (nothing is written). A command's
 * `channelIds` must be channels the bot reaches. Managers' switches
 * (enabled, channel restriction) survive.
 */
async function handlePut(req: Request, _ctx: unknown, bot: BotRow): Promise<NextResponse> {
  const denied = requireBotPermission(bot, 'slash_commands');
  if (denied) return denied;
  const json = await readJsonBody(req);
  if (!json.ok) return json.response;
  const parsed = CommandListSchema.safeParse(json.body);
  if (!parsed.success) return invalidRequest(parsed.error);
  const commands = parsed.data;

  const wantedChannels = new Set(commands.flatMap((c) => c.channelIds ?? []));
  if (wantedChannels.size > 0) {
    const reachable = new Set((await listBotChannels(bot)).map((c) => c.id));
    const unknown = [...wantedChannels].filter((id) => !reachable.has(id));
    if (unknown.length > 0) {
      return botError(400, 'invalid_request', 'channelIds must be channels this bot can access', {
        issues: unknown.map((id) => `channelIds: ${id} is not available to this bot`),
      });
    }
  }

  const names = commands.map((c) => c.name);
  const taken = await findCommandNamesTakenByOtherBots(getDb(), { serverId: bot.serverId, botId: bot.id, names });
  if (taken.length > 0) {
    return botError(409, 'command_name_taken', 'Another bot of this server already owns these command names', { names: taken });
  }

  try {
    const rows = await replaceBotCommands(getDb(), {
      botId: bot.id,
      serverId: bot.serverId,
      commands: commands.map((c) => ({
        name: c.name,
        description: c.description,
        options: normalizeCommandOptions(c.options),
        channelIds: c.channelIds ? Array.from(new Set(c.channelIds.map((id) => id.toLowerCase()))) : null,
        requiredPermission: c.requiredPermission ?? null,
      })),
    });
    return NextResponse.json({ commands: rows.map(toBotCommandJson) });
  } catch (err) {
    // A concurrent registration by another bot took a name between the
    // check above and the write — the transaction rolled back.
    if (err instanceof CommandNameTakenError) {
      return botError(409, 'command_name_taken', 'Another bot of this server already owns these command names', { names: err.names });
    }
    throw err;
  }
}

export const GET = botApiRoute(
  withMachineApiSecurity(withBotAuth(handleGet), botApiOptions(['GET'], 'v2-commands-list', V2_READ_LIMIT))
);

export const PUT = botApiRoute(
  withMachineApiSecurity(
    withBotAuth(handlePut),
    botApiOptions(['PUT'], 'v2-commands-put', V2_COMMANDS_PUT_LIMIT, MAX_COMMANDS_BODY_BYTES)
  )
);
