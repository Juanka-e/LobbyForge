import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getBotById, getBotCommandById, listChannelsForServer, updateBotCommandAdmin } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { auditBotAction, invalidBody, jsonErrors, requireBotManager } from '@/lib/bots/admin';
import { toAdminCommandJson } from '@/lib/bots/commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string; botId: string; commandId: string }> };

const PatchSchema = z
  .object({
    enabled: z.boolean(),
    /** null = no restriction; else the command runs only in these channels. */
    channelIds: z.array(z.string().uuid()).min(1).max(500).nullable(),
  })
  .strict()
  .partial()
  .refine((value) => value.enabled !== undefined || value.channelIds !== undefined, 'Nothing to change');

const BOT_CHANNEL_TYPES = new Set(['text', 'announcement']);

/**
 * PATCH /api/servers/{id}/bots/{botId}/commands/{commandId}
 * `{ enabled?, channelIds? }` — the managers' switches on a registered
 * command: on/off, and a channel restriction intersected with the bot's own
 * list. The bot re-registering its commands never resets them — not even a
 * delete + re-register (they are kept per bot and command name in
 * `bot_command_overrides`). Removing a command entirely is the bot's call
 * (or disable / delete the bot).
 */
async function handlePatch(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, botId, commandId } = await ctx.params;
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return auth.response;
  const uuid = z.string().uuid();
  const bot = uuid.safeParse(botId).success ? await getBotById(getDb(), botId) : null;
  const command = bot && uuid.safeParse(commandId).success ? await getBotCommandById(getDb(), commandId) : null;
  if (!bot || bot.serverId !== serverId || !command || command.botId !== bot.id) {
    return NextResponse.json({ error: 'Command not found', code: 'not_found' }, { status: 404 });
  }
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidBody(parsed.error.issues);

  let adminChannelIds: string[] | null | undefined;
  if (parsed.data.channelIds !== undefined) {
    if (parsed.data.channelIds === null) {
      adminChannelIds = null;
    } else {
      const ids = Array.from(new Set(parsed.data.channelIds.map((id) => id.toLowerCase())));
      const eligible = new Set(
        (await listChannelsForServer(getDb(), serverId, { limit: 500 })).filter((c) => BOT_CHANNEL_TYPES.has(c.type)).map((c) => c.id)
      );
      const invalid = ids.filter((id) => !eligible.has(id));
      if (invalid.length > 0) {
        return NextResponse.json(
          { error: 'Only text or announcement channels of this server', code: 'invalid_channel', channelIds: invalid },
          { status: 400 }
        );
      }
      adminChannelIds = ids;
    }
  }
  // Also recorded per (bot, command name): the bot deleting and
  // re-registering the command gets these switches back, not the defaults.
  const updated = await updateBotCommandAdmin(getDb(), command.id, {
    ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
    ...(adminChannelIds !== undefined ? { adminChannelIds } : {}),
    updatedBy: auth.manager.uid,
  });
  if (!updated) return NextResponse.json({ error: 'Command not found', code: 'not_found' }, { status: 404 });
  auditBotAction({
    serverId,
    actorUserId: auth.manager.uid,
    action: 'bot.command.update',
    bot,
    metadata: {
      command: command.name,
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...(adminChannelIds !== undefined ? { channelIds: adminChannelIds } : {}),
    },
  });
  return NextResponse.json({ command: toAdminCommandJson(updated) }, { headers: { 'Cache-Control': 'no-store' } });
}

export const PATCH = withApiSecurity(jsonErrors('update bot command', handlePatch), {
  allowedMethods: ['PATCH'],
  maxBodyBytes: 32 * 1024,
  rateLimit: { identifier: 'server-bots-commands-update', config: { windowMs: 60_000, maxRequests: 30 } },
});
