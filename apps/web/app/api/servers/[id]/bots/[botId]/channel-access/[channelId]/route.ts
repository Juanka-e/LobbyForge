import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getBotById, grantBotChannelAccess, revokeBotChannelAccess, type BotRow } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { auditBotAction, jsonErrors, requireBotManager } from '@/lib/bots/admin';
import { canGrantGatedChannels, channelAccessJson, loadChannelAccessView } from '@/lib/bots/access';
import { announceChannelAccessChange } from '@/lib/bots/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string; botId: string; channelId: string }> };

const noStore = { headers: { 'Cache-Control': 'no-store' } };
const NOT_FOUND = (what: string) => NextResponse.json({ error: `${what} not found`, code: 'not_found' }, { status: 404 });

async function loadServerBot(serverId: string, botId: string): Promise<BotRow | null> {
  if (!z.string().uuid().safeParse(botId).success) return null;
  const bot = await getBotById(getDb(), botId);
  return bot && bot.serverId === serverId ? bot : null;
}

async function prepare(req: Request, ctx: RouteContext) {
  const { id: serverId, botId, channelId } = await ctx.params;
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return { ok: false as const, response: auth.response };
  const bot = await loadServerBot(serverId, botId);
  if (!bot) return { ok: false as const, response: NOT_FOUND('Bot') };
  const manager = { uid: auth.manager.uid, isOwner: auth.manager.isOwner, permissions: auth.manager.permissions };
  const view = await loadChannelAccessView(bot, manager);
  const channel = z.string().uuid().safeParse(channelId).success ? view.eligible.get(channelId.toLowerCase()) : undefined;
  // A channel the manager cannot see is "not found" to them, like everywhere else.
  if (!channel || !channel.visible) return { ok: false as const, response: NOT_FOUND('Channel') };
  if (view.mode === 'all') {
    // One grant would silently narrow "every open channel" down to one
    // channel (and one revoke cannot apply at all): switching modes is an
    // explicit bulk PUT on the collection.
    return {
      ok: false as const,
      response: NextResponse.json(
        {
          error: 'This bot uses every open channel; choose its channels with PUT …/channel-access first',
          code: 'access_mode_all',
        },
        { status: 409 }
      ),
    };
  }
  return { ok: true as const, serverId, bot, manager, view, channelId: channelId.toLowerCase(), gated: channel.gated, uid: auth.manager.uid };
}

/**
 * PUT …/channel-access/{channelId} — grant one more channel (selected mode
 * only; the write itself re-checks the mode under a row lock, so a
 * concurrent switch to `all` cannot leave a stray grant behind).
 */
async function handlePut(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const ready = await prepare(req, ctx);
  if (!ready.ok) return ready.response;
  if (ready.gated && !canGrantGatedChannels(ready.manager)) {
    return NextResponse.json(
      { error: 'Granting a private channel needs the Manage Channels permission', code: 'cannot_grant_channel', channelIds: [ready.channelId] },
      { status: 403 }
    );
  }
  if (await grantBotChannelAccess(getDb(), { botId: ready.bot.id, channelId: ready.channelId, grantedBy: ready.uid })) {
    auditBotAction({
      serverId: ready.serverId,
      actorUserId: ready.uid,
      action: 'bot.channel_access',
      bot: ready.bot,
      metadata: { mode: 'selected', added: [ready.channelId], removed: [] },
    });
    await announceChannelAccessChange(ready.bot);
  }
  return NextResponse.json({ access: channelAccessJson(await loadChannelAccessView(ready.bot, ready.manager)) }, noStore);
}

/**
 * DELETE …/channel-access/{channelId} — revoke one channel (selected mode
 * only). Revoking the LAST grant is allowed: the mode is stored, so a
 * `selected` bot without grants reaches NO channel — narrowing, never
 * widening, whatever the order of concurrent revokes.
 */
async function handleDelete(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const ready = await prepare(req, ctx);
  if (!ready.ok) return ready.response;
  if (await revokeBotChannelAccess(getDb(), ready.bot.id, ready.channelId)) {
    auditBotAction({
      serverId: ready.serverId,
      actorUserId: ready.uid,
      action: 'bot.channel_access',
      bot: ready.bot,
      metadata: { mode: 'selected', added: [], removed: [ready.channelId] },
    });
    await announceChannelAccessChange(ready.bot);
  }
  return NextResponse.json({ access: channelAccessJson(await loadChannelAccessView(ready.bot, ready.manager)) }, noStore);
}

export const PUT = withApiSecurity(jsonErrors('grant bot channel', handlePut), {
  allowedMethods: ['PUT'],
  rateLimit: { identifier: 'server-bots-channel-grant', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const DELETE = withApiSecurity(jsonErrors('revoke bot channel', handleDelete), {
  allowedMethods: ['DELETE'],
  rateLimit: { identifier: 'server-bots-channel-revoke', config: { windowMs: 60_000, maxRequests: 30 } },
});
