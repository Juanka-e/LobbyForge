import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getBotById, setBotTokenHash } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { auditBotAction, jsonErrors, requireBotManager, toBotJson } from '@/lib/bots/admin';
import { CUSTOM_BOT_TYPE, findUngrantableBotPermissions, isBotPermission } from '@/lib/bots/permissions';
import { generateBotToken } from '@/lib/bots/token';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string; botId: string }> };

const NOT_FOUND = () => NextResponse.json({ error: 'Bot not found', code: 'not_found' }, { status: 404 });

async function loadCustomBot(serverId: string, botId: string) {
  if (!z.string().uuid().safeParse(botId).success) return { bot: null, builtIn: false };
  const bot = await getBotById(getDb(), botId);
  if (!bot || bot.serverId !== serverId) return { bot: null, builtIn: false };
  return { bot, builtIn: bot.type !== CUSTOM_BOT_TYPE };
}

const BUILT_IN_HAS_NO_TOKEN = () =>
  NextResponse.json(
    { error: 'Built-in bots run inside LobbyForge and have no token', code: 'builtin_has_no_token' },
    { status: 400 }
  );

/**
 * POST — issue a token, or rotate it: the previous token stops working
 * the moment this returns. The new token is in the response, once.
 */
async function handlePost(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, botId } = await ctx.params;
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return auth.response;

  const { bot, builtIn } = await loadCustomBot(serverId, botId);
  if (!bot) return NOT_FOUND();
  if (builtIn) return BUILT_IN_HAS_NO_TOKEN();

  // Whoever holds the token wields every permission the bot has, so a
  // new token is a fresh grant of all of them: the caller must be able to
  // grant each one (the same rule as bot create / PATCH). Ids that are no
  // longer known grant nothing and are not held against the caller.
  const ungrantable = findUngrantableBotPermissions({
    actorIsOwner: auth.manager.isOwner,
    actorPermissions: auth.manager.permissions,
    requested: bot.permissions.filter(isBotPermission),
  });
  if (ungrantable.length > 0) {
    return NextResponse.json(
      {
        error: 'You cannot take a token for a bot that has permissions you do not have',
        code: 'ungrantable_permissions',
        permissions: ungrantable,
      },
      { status: 403 }
    );
  }

  const { token, hash } = generateBotToken(bot.id);
  const updated = await setBotTokenHash(getDb(), bot.id, hash);
  if (!updated) return NOT_FOUND();
  auditBotAction({
    serverId,
    actorUserId: auth.manager.uid,
    action: bot.tokenHash ? 'bot.token.rotate' : 'bot.token.issue',
    bot: updated,
  });
  return NextResponse.json(
    { bot: toBotJson(updated, { includeSettings: true }), token },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

/** DELETE — revoke the token. The bot stays; it just cannot call the API. */
async function handleDelete(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, botId } = await ctx.params;
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return auth.response;

  const { bot, builtIn } = await loadCustomBot(serverId, botId);
  if (!bot) return NOT_FOUND();
  if (builtIn) return BUILT_IN_HAS_NO_TOKEN();

  const updated = await setBotTokenHash(getDb(), bot.id, null);
  if (!updated) return NOT_FOUND();
  auditBotAction({ serverId, actorUserId: auth.manager.uid, action: 'bot.token.revoke', bot: updated });
  return NextResponse.json(
    { bot: toBotJson(updated, { includeSettings: true }) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const POST = withApiSecurity(jsonErrors('rotate bot token', handlePost), {
  allowedMethods: ['POST'],
  maxBodyBytes: 1024,
  rateLimit: { identifier: 'server-bots-token', config: { windowMs: 60_000, maxRequests: 10 } },
});

export const DELETE = withApiSecurity(jsonErrors('revoke bot token', handleDelete), {
  allowedMethods: ['DELETE'],
  rateLimit: { identifier: 'server-bots-token', config: { windowMs: 60_000, maxRequests: 10 } },
});
