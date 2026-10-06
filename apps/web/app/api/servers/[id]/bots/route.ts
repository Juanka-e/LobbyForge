import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { countBotsForServer, createBot, getUserPermissions, listBotsForServer } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession, requireServerMember } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';
import {
  auditBotAction,
  BotNameSchema,
  canManageBots,
  invalidBody,
  jsonErrors,
  requireBotManager,
  toBotJson,
} from '@/lib/bots/admin';
import {
  BOT_PERMISSIONS,
  CUSTOM_BOT_TYPE,
  MAX_CUSTOM_BOTS_PER_SERVER,
  findUngrantableBotPermissions,
} from '@/lib/bots/permissions';
import { generateBotToken } from '@/lib/bots/token';
import { requireVerifiedEmail } from '@/lib/mail/verification';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CreateBotSchema = z
  .object({
    name: BotNameSchema,
    permissions: z.array(z.enum(BOT_PERMISSIONS)).max(BOT_PERMISSIONS.length).default([]),
  })
  .strict();

/**
 * GET — every member of the server may list its bots (the BOT badge and
 * bot profiles are public inside the server). Settings only for managers.
 */
async function handleGet(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  const member = await requireServerMember(session.session.uid, serverId);
  if (!member.ok) return member.response;

  const permissions = await getUserPermissions(getDb(), session.session.uid, serverId);
  const includeSettings = canManageBots(permissions);
  const rows = await listBotsForServer(getDb(), serverId);
  return NextResponse.json(
    { bots: rows.map((row) => toBotJson(row, { includeSettings })), canManage: includeSettings },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * POST — create a custom (Bot API) bot. The response carries the token;
 * it is shown this once and only its hash is stored.
 */
async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const auth = await requireBotManager(req, serverId);
  if (!auth.ok) return auth.response;
  const { manager } = auth;
  // docs/EMAIL.md §4.2: an unverified account in `required` mode may read, not do this.
  const unverified = await requireVerifiedEmail(manager.uid, 'bot_create');
  if (unverified) return unverified;

  const parsed = CreateBotSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidBody(parsed.error.issues);
  const permissions = Array.from(new Set(parsed.data.permissions));

  const ungrantable = findUngrantableBotPermissions({
    actorIsOwner: manager.isOwner,
    actorPermissions: manager.permissions,
    requested: permissions,
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

  if ((await countBotsForServer(getDb(), serverId, CUSTOM_BOT_TYPE)) >= MAX_CUSTOM_BOTS_PER_SERVER) {
    return NextResponse.json(
      {
        error: `A server can have at most ${MAX_CUSTOM_BOTS_PER_SERVER} custom bots`,
        code: 'limit_reached',
        limit: MAX_CUSTOM_BOTS_PER_SERVER,
      },
      { status: 409 }
    );
  }

  const botId = randomUUID();
  const { token, hash } = generateBotToken(botId);
  const bot = await createBot(getDb(), {
    id: botId,
    serverId,
    name: parsed.data.name,
    type: CUSTOM_BOT_TYPE,
    permissions,
    createdBy: manager.uid,
    tokenHash: hash,
  });
  auditBotAction({
    serverId,
    actorUserId: manager.uid,
    action: 'bot.create',
    bot,
    metadata: { permissions, tokenIssued: true },
  });
  return NextResponse.json(
    { bot: toBotJson(bot, { includeSettings: true }), token },
    { status: 201, headers: { 'Cache-Control': 'no-store' } }
  );
}

export const GET = withApiSecurity(jsonErrors('list bots', handleGet), {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'server-bots-list', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const POST = withApiSecurity(jsonErrors('create bot', handlePost), {
  allowedMethods: ['POST'],
  maxBodyBytes: 2 * 1024,
  rateLimit: { identifier: 'server-bots-create', config: { windowMs: 60_000, maxRequests: 10 } },
});
