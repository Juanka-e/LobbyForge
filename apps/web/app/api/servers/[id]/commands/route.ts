import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CorePermission, hasPermission, type CorePermission as CorePermissionT } from '@lobbyforge/core';
import {
  getUserPermissions,
  isChannelOpenToBots,
  listBotChannelAccessForServer,
  listServerCommands,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';
import { authorizeChannelMessageAccess } from '@/lib/message-authorization';
import { jsonErrors } from '@/lib/bots/admin';
import { botReachesChannel, isAllChannelsMode } from '@/lib/bots/access';
import { commandAllowedInChannel, readCommandOptions } from '@/lib/bots/commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

const BOT_CHANNEL_TYPES = new Set(['text', 'announcement']);

/**
 * GET /api/servers/{id}/commands?channelId= — the slash commands this
 * member may run in that channel, for the composer's `/` picker
 * (docs/BOT_API_V2.md §3.3): `{ commands: [{ id, name, description,
 * options, bot: { id, name } }] }`, grouped by bot.
 *
 * A command is listed only when every invoke-time check would pass on the
 * command's side: enabled; allowed in this channel by the bot and by the
 * managers; its bot enabled, holding `slash_commands` and reaching this
 * channel; and the member holds its `requiredPermission` (owner bypass).
 * The member must be able to send in the channel at all. Fixed number of
 * queries, whatever the number of bots.
 */
async function handleGet(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  const channelId = new URL(req.url).searchParams.get('channelId');
  if (!channelId || !z.string().uuid().safeParse(channelId).success) {
    return NextResponse.json({ error: 'channelId is required', code: 'invalid_request' }, { status: 400 });
  }
  const uid = session.session.uid;
  const access = await authorizeChannelMessageAccess({ userId: uid, serverId, channelId, operation: 'send' });
  if (!access.ok) return access.response;
  const { channel, server } = access.context;
  const noStore = { headers: { 'Cache-Control': 'no-store' } };
  if (!BOT_CHANNEL_TYPES.has(channel.type)) return NextResponse.json({ commands: [] }, noStore);

  const rows = await listServerCommands(getDb(), serverId);
  const candidates = rows.filter(
    (row) =>
      row.enabled &&
      row.bot.enabled &&
      row.bot.type === 'custom' &&
      row.bot.permissions.includes('slash_commands') &&
      commandAllowedInChannel(row, channelId)
  );
  if (candidates.length === 0) return NextResponse.json({ commands: [] }, noStore);

  const grants = await listBotChannelAccessForServer(getDb(), serverId);
  const needsGate = candidates.some((row) => isAllChannelsMode(row.bot.channelAccessMode));
  const openToBots = needsGate ? await isChannelOpenToBots(getDb(), channelId) : false;
  const isOwner = server.ownerUserId === uid;
  const permissions = candidates.some((row) => row.requiredPermission) && !isOwner
    ? await getUserPermissions(getDb(), uid, serverId)
    : [];

  const commands = candidates
    .filter((row) =>
      botReachesChannel({ mode: row.bot.channelAccessMode, granted: grants.get(row.botId) ?? [], channelId, openToBots })
    )
    .filter(
      (row) =>
        !row.requiredPermission ||
        isOwner ||
        ((Object.values(CorePermission) as string[]).includes(row.requiredPermission) &&
          hasPermission(permissions, row.requiredPermission as CorePermissionT))
    )
    .map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      options: readCommandOptions(row.options),
      bot: { id: row.bot.id, name: row.bot.name },
    }));
  return NextResponse.json({ commands }, noStore);
}

export const GET = withApiSecurity(jsonErrors('list commands', handleGet), {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'server-commands-list', config: { windowMs: 60_000, maxRequests: 60 } },
});
