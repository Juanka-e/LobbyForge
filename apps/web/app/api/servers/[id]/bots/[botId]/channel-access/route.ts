import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getBotById, setBotChannelAccess, type BotRow } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { auditBotAction, invalidBody, jsonErrors, requireBotManager, type BotManager } from '@/lib/bots/admin';
import { canGrantGatedChannels, channelAccessJson, loadChannelAccessView } from '@/lib/bots/access';
import { announceChannelAccessChange } from '@/lib/bots/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string; botId: string }> };

const PutAccessSchema = z
  .object({
    /** null → mode `all` (every channel without a role gate); else mode `selected`, exactly these. */
    channelIds: z.array(z.string().uuid()).min(1).max(500).nullable(),
  })
  .strict();

const NOT_FOUND = () => NextResponse.json({ error: 'Bot not found', code: 'not_found' }, { status: 404 });
const noStore = { headers: { 'Cache-Control': 'no-store' } };

async function loadServerBot(serverId: string, botId: string): Promise<BotRow | null> {
  if (!z.string().uuid().safeParse(botId).success) return null;
  const bot = await getBotById(getDb(), botId);
  return bot && bot.serverId === serverId ? bot : null;
}

function managerOf(manager: BotManager) {
  return { uid: manager.uid, isOwner: manager.isOwner, permissions: manager.permissions };
}

/**
 * GET /api/servers/{id}/bots/{botId}/channel-access — which channels the
 * bot reaches (docs/BOT_API_V2.md §1.1), as this manager may see them.
 * Needs Manage Community.
 */
async function handleGet(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, botId } = await ctx.params;
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return auth.response;
  const bot = await loadServerBot(serverId, botId);
  if (!bot) return NOT_FOUND();
  const view = await loadChannelAccessView(bot, managerOf(auth.manager));
  return NextResponse.json({ access: channelAccessJson(view) }, noStore);
}

/**
 * PUT /api/servers/{id}/bots/{botId}/channel-access  { channelIds: [...] | null }
 * Set the bot's mode and channels in one transaction: `null` → mode `all`
 * (every channel without a role gate; grant rows deleted); a list → mode
 * `selected`, exactly those text / announcement channels of this server.
 * Adding a role-gated channel needs Manage Channels (§1.1). Grants on
 * role-gated channels this manager cannot see are kept untouched, and a
 * grant that stays keeps who made it. Audited as `bot.channel_access`.
 */
async function handlePut(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, botId } = await ctx.params;
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return auth.response;
  const bot = await loadServerBot(serverId, botId);
  if (!bot) return NOT_FOUND();
  const parsed = PutAccessSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidBody(parsed.error.issues);

  const manager = managerOf(auth.manager);
  const view = await loadChannelAccessView(bot, manager);
  const before = new Set([...view.channels.filter((c) => c.granted).map((c) => c.id), ...view.hiddenGrantIds]);

  let next: string[];
  const nextMode = parsed.data.channelIds === null ? 'all' : 'selected';
  if (parsed.data.channelIds === null) {
    // Back to the v1 rule. Hidden grants cannot survive that switch (mode
    // `all` keeps no rows), so only someone who sees every channel may make
    // it while they exist.
    if (view.hiddenGrantIds.length > 0 && !canGrantGatedChannels(manager)) {
      return NextResponse.json(
        { error: 'This bot has access to private channels you cannot see', code: 'cannot_change_hidden_access' },
        { status: 403 }
      );
    }
    next = [];
  } else {
    const requested = Array.from(new Set(parsed.data.channelIds.map((id) => id.toLowerCase())));
    const invalid = requested.filter((id) => {
      const info = view.eligible.get(id);
      return !info || !info.visible;
    });
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: 'Only text or announcement channels of this server can be granted', code: 'invalid_channel', channelIds: invalid },
        { status: 400 }
      );
    }
    const ungrantable = requested.filter((id) => !before.has(id) && view.eligible.get(id)!.gated && !canGrantGatedChannels(manager));
    if (ungrantable.length > 0) {
      return NextResponse.json(
        { error: 'Granting a private channel needs the Manage Channels permission', code: 'cannot_grant_channel', channelIds: ungrantable },
        { status: 403 }
      );
    }
    next = Array.from(new Set([...requested, ...view.hiddenGrantIds]));
  }

  const added = next.filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !next.includes(id));
  // A mode switch is a change on its own (e.g. `selected` with no channel
  // left → `all`, where no grant is added or removed).
  if (added.length > 0 || removed.length > 0 || view.mode !== nextMode) {
    await setBotChannelAccess(
      getDb(),
      nextMode === 'all'
        ? { botId: bot.id, mode: 'all' }
        : { botId: bot.id, mode: 'selected', channelIds: next, grantedBy: auth.manager.uid }
    );
    auditBotAction({
      serverId,
      actorUserId: auth.manager.uid,
      action: 'bot.channel_access',
      bot,
      metadata: { mode: nextMode, added, removed },
    });
    await announceChannelAccessChange(bot);
  }
  const updated = await loadChannelAccessView(bot, manager);
  return NextResponse.json({ access: channelAccessJson(updated) }, noStore);
}

export const GET = withApiSecurity(jsonErrors('bot channel access', handleGet), {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'server-bots-channel-access-get', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const PUT = withApiSecurity(jsonErrors('set bot channel access', handlePut), {
  allowedMethods: ['PUT'],
  maxBodyBytes: 32 * 1024,
  rateLimit: { identifier: 'server-bots-channel-access-put', config: { windowMs: 60_000, maxRequests: 30 } },
});
