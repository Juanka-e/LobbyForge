import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteBot, getBotById, updateBot, type UpdateBotInput } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import {
  auditBotAction,
  BotNameSchema,
  invalidBody,
  jsonErrors,
  requireBotManager,
  toBotJson,
} from '@/lib/bots/admin';
import { invalidateBotCache } from '@/lib/bots/cache';
import { notifyBotChanged } from '@/lib/bots/events';
import { BOT_PERMISSIONS, findUngrantableBotPermissions, isBuiltInType } from '@/lib/bots/permissions';
import { CorePermission, hasPermission } from '@lobbyforge/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string; botId: string }> };

const PatchBotSchema = z
  .object({
    name: BotNameSchema,
    enabled: z.boolean(),
    permissions: z.array(z.enum(BOT_PERMISSIONS)).max(BOT_PERMISSIONS.length),
  })
  .strict()
  .partial();

const NOT_FOUND = () => NextResponse.json({ error: 'Bot not found', code: 'not_found' }, { status: 404 });

/** The bot, only if it belongs to the server in the URL. */
async function loadServerBot(serverId: string, botId: string) {
  if (!z.string().uuid().safeParse(botId).success) return null;
  const bot = await getBotById(getDb(), botId);
  return bot && bot.serverId === serverId ? bot : null;
}

/** PATCH — rename, enable/disable, or change a custom bot's permissions. */
async function handlePatch(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, botId } = await ctx.params;
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return auth.response;
  const { manager } = auth;

  const bot = await loadServerBot(serverId, botId);
  if (!bot) return NOT_FOUND();

  const parsed = PatchBotSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidBody(parsed.error.issues);
  const body = parsed.data;

  const patch: UpdateBotInput = {};
  const changes: Record<string, unknown> = {};
  if (body.name !== undefined && body.name !== bot.name) {
    patch.name = body.name;
    changes.name = { from: bot.name, to: body.name };
  }
  // Same rule as PUT /bots/builtin/moderation: switching on the bot that
  // removes members' messages takes the right to remove them yourself.
  if (
    body.enabled === true &&
    bot.type === 'moderation' &&
    !manager.isOwner &&
    !hasPermission([...manager.permissions], CorePermission.MANAGE_MESSAGES)
  ) {
    return NextResponse.json({ error: 'Forbidden', code: 'missing_permission' }, { status: 403 });
  }
  if (body.enabled !== undefined && body.enabled !== bot.enabled) {
    patch.enabled = body.enabled;
    changes.enabled = body.enabled;
  }
  if (body.permissions !== undefined) {
    if (isBuiltInType(bot.type)) {
      return NextResponse.json(
        { error: 'A built-in bot has a fixed set of permissions', code: 'builtin_permissions_fixed' },
        { status: 400 }
      );
    }
    const next = Array.from(new Set(body.permissions));
    const ungrantable = findUngrantableBotPermissions({
      actorIsOwner: manager.isOwner,
      actorPermissions: manager.permissions,
      requested: next,
      alreadyGranted: bot.permissions,
    });
    if (ungrantable.length > 0) {
      return NextResponse.json(
        {
          error: 'You cannot give a bot permissions you do not have',
          code: 'ungrantable_permissions',
          permissions: ungrantable,
        },
        { status: 403 }
      );
    }
    const added = next.filter((p) => !bot.permissions.includes(p));
    const removed = bot.permissions.filter((p) => !next.includes(p as (typeof next)[number]));
    if (added.length > 0 || removed.length > 0) {
      patch.permissions = next;
      changes.permissions = { added, removed };
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ bot: toBotJson(bot, { includeSettings: true }) }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const updated = await updateBot(getDb(), bot.id, patch);
  if (!updated) return NOT_FOUND();
  invalidateBotCache(serverId);
  // Bot API v2: the gateway re-checks (or closes) the bot's event stream,
  // and the event fan-out forgets its cached copy of the bot.
  if (patch.permissions !== undefined || patch.enabled !== undefined) {
    notifyBotChanged({
      serverId,
      botId: bot.id,
      reason: patch.permissions !== undefined ? 'permissions_changed' : 'enabled_changed',
    });
  }
  const onlyToggle = Object.keys(changes).length === 1 && 'enabled' in changes;
  auditBotAction({
    serverId,
    actorUserId: manager.uid,
    action: onlyToggle ? (patch.enabled ? 'bot.enable' : 'bot.disable') : 'bot.update',
    bot: updated,
    metadata: onlyToggle ? {} : { changes },
  });
  return NextResponse.json({ bot: toBotJson(updated, { includeSettings: true }) }, { headers: { 'Cache-Control': 'no-store' } });
}

/** DELETE — remove the bot. Its messages stay, still labelled as a bot's. */
async function handleDelete(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, botId } = await ctx.params;
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return auth.response;

  const bot = await loadServerBot(serverId, botId);
  if (!bot) return NOT_FOUND();
  if (!(await deleteBot(getDb(), bot.id))) return NOT_FOUND();
  invalidateBotCache(serverId);
  notifyBotChanged({ serverId, botId: bot.id, reason: 'deleted' });
  auditBotAction({ serverId, actorUserId: auth.manager.uid, action: 'bot.delete', bot });
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}

export const PATCH = withApiSecurity(jsonErrors('update bot', handlePatch), {
  allowedMethods: ['PATCH'],
  maxBodyBytes: 2 * 1024,
  rateLimit: { identifier: 'server-bots-update', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const DELETE = withApiSecurity(jsonErrors('delete bot', handleDelete), {
  allowedMethods: ['DELETE'],
  rateLimit: { identifier: 'server-bots-delete', config: { windowMs: 60_000, maxRequests: 30 } },
});
