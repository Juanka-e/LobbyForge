import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CorePermission, hasPermission, type CorePermission as CorePermissionT } from '@lobbyforge/core';
import {
  createBotInteraction,
  getActiveMemberTimeout,
  getBotById,
  getBotCommandById,
  getChannelById,
  getUserPermissions,
  isServerMember,
  listUserDisplayNames,
  logAction,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { distributedRateLimit, rateLimitResponse, withApiSecurity, type RateLimitConfig } from '@/lib/security-headers';
import { authorizeChannelMessageAccess } from '@/lib/message-authorization';
import { authorizeChannelVisibility } from '@/lib/permissions';
import { jsonErrors } from '@/lib/bots/admin';
import { botCanAccessChannel } from '@/lib/bots/access';
import { INTERACTION_TTL_MS } from '@/lib/bots/catalog';
import { commandAllowedInChannel, freeTextOf, readCommandOptions, validateOptionValues } from '@/lib/bots/commands';
import { dispatchInteractionCreate, sweepExpiredInteractions } from '@/lib/bots/interactions';
import { moderateMessage, moderationBlockedBody } from '@/lib/bots/moderation';
import { botHasPermission } from '@/lib/bots/permissions';
import { requireVerifiedEmail } from '@/lib/mail/verification';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string; channelId: string; commandId: string }> };

/** Command runs per member (§3.3), across every channel and server. */
const INVOKE_USER_LIMIT: RateLimitConfig = { windowMs: 60_000, maxRequests: 20 };

const InvokeSchema = z
  .object({ options: z.record(z.string(), z.unknown()).optional() })
  .strict();

function error(status: number, code: string, message: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error: message, code, ...extra }, { status, headers: { 'Cache-Control': 'no-store' } });
}

const UNAVAILABLE = () => error(404, 'command_not_available', 'This command is not available in this channel');

/**
 * POST /api/servers/{id}/channels/{channelId}/commands/{commandId}/invoke
 * body `{ options: { [name]: value } }` → `202 { interaction: { id, status: 'pending', … } }`.
 *
 * Checks, in order (docs/BOT_API_V2.md §3.3): the member can see the
 * channel and has SEND_MESSAGES, and is not timed out; the command exists
 * in this server, is enabled and allowed in this channel; the member holds
 * its `requiredPermission` (owner bypass); its bot is enabled, holds
 * `slash_commands` and reaches the channel; the options validate against
 * the stored schema — `user` options must be members of the server and
 * `channel` options channels the member can see. Free-text options go
 * through the Moderation Bot's content rules like a message. Then the
 * interaction row is written and delivered to the bot's stream and
 * endpoint. 20 runs per minute per member.
 */
async function handlePost(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, channelId, commandId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  const uid = session.session.uid;
  // docs/EMAIL.md §4.2: an unverified account in `required` mode may read, not do this.
  const unverified = await requireVerifiedEmail(uid, 'message');
  if (unverified) return unverified;

  const limited = rateLimitResponse(await distributedRateLimit(`command-invoke:${uid}`, INVOKE_USER_LIMIT), 'command-invoke');
  if (limited) {
    const body = (await limited.json()) as Record<string, unknown>;
    return NextResponse.json({ ...body, code: 'rate_limited' }, { status: 429, headers: limited.headers });
  }

  if (!z.string().uuid().safeParse(commandId).success) return error(404, 'command_not_found', 'Command not found');

  // 1. Membership + channel visibility + SEND_MESSAGES, then timeouts.
  const access = await authorizeChannelMessageAccess({ userId: uid, serverId, channelId, operation: 'send' });
  if (!access.ok) return access.response;
  const timedOutUntil = await getActiveMemberTimeout(getDb(), serverId, uid);
  if (timedOutUntil) {
    return error(403, 'timed_out', 'You are timed out in this server', { until: timedOutUntil.toISOString() });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return error(400, 'invalid_request', 'Body must be JSON');
  }
  const body = InvokeSchema.safeParse(raw);
  if (!body.success) return error(400, 'invalid_request', 'Invalid request body');

  // 2. The command: this server's, enabled, allowed here.
  const command = await getBotCommandById(getDb(), commandId);
  if (!command || command.serverId !== serverId) return error(404, 'command_not_found', 'Command not found');
  if (!command.enabled) return error(403, 'command_disabled', 'This command is disabled');
  if (!commandAllowedInChannel(command, channelId)) return UNAVAILABLE();

  // 3. The invoker's required permission (the owner holds every permission).
  const isOwner = access.context.server.ownerUserId === uid;
  if (command.requiredPermission && !isOwner) {
    const known = (Object.values(CorePermission) as string[]).includes(command.requiredPermission);
    const permissions = await getUserPermissions(getDb(), uid, serverId);
    if (!known || !hasPermission(permissions, command.requiredPermission as CorePermissionT)) {
      return error(403, 'missing_permission', 'You do not have the permission this command requires', {
        permission: command.requiredPermission,
      });
    }
  }

  // 4. The bot: enabled, allowed to take commands, reaching this channel.
  const bot = await getBotById(getDb(), command.botId);
  if (!bot || bot.serverId !== serverId || !bot.enabled || bot.type !== 'custom' || !botHasPermission(bot, 'slash_commands')) {
    return error(409, 'bot_unavailable', 'The bot behind this command is not available');
  }
  if (!(await botCanAccessChannel(bot, channelId))) return UNAVAILABLE();

  // 5. Options, server-side, including the database re-checks.
  const options = readCommandOptions(command.options);
  const checked = validateOptionValues(options, body.data.options);
  if (!checked.ok) return error(400, 'invalid_options', 'Some options are not valid', { issues: checked.issues });
  const issues: string[] = [];
  for (const ref of checked.users) {
    const member = ref.id === access.context.server.ownerUserId || (await isServerMember(getDb(), ref.id, serverId));
    if (!member) issues.push(`${ref.option}: not a member of this server`);
  }
  for (const ref of checked.channels) {
    const target = await getChannelById(getDb(), ref.id);
    const visible =
      target &&
      target.serverId === serverId &&
      (await authorizeChannelVisibility(uid, serverId, ref.id, access.context.server.ownerUserId)).ok;
    if (!visible) issues.push(`${ref.option}: not a channel you can see`);
  }
  if (issues.length > 0) return error(400, 'invalid_options', 'Some options are not valid', { issues });

  // 6. What the member typed is moderated like a message (content rules;
  //    the invoke limit above stands in for the flood rules).
  const freeText = freeTextOf(options, checked.values);
  if (freeText) {
    const verdict = await moderateMessage({
      serverId,
      channelId,
      userId: uid,
      content: freeText,
      ownerUserId: access.context.server.ownerUserId,
      kind: 'edit',
    });
    if (verdict.action === 'block') {
      return NextResponse.json(moderationBlockedBody(verdict), { status: 422, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  // 7. Record and deliver.
  const now = new Date();
  void sweepExpiredInteractions(bot.id, now);
  const interaction = await createBotInteraction(
    getDb(),
    {
      botId: bot.id,
      commandId: command.id,
      serverId,
      channelId,
      userId: uid,
      commandName: command.name,
      options: checked.values,
      expiresAt: new Date(now.getTime() + INTERACTION_TTL_MS),
    },
    now
  );
  const names = await listUserDisplayNames(getDb(), [uid]);
  void dispatchInteractionCreate({ bot, interaction, user: { id: uid, displayName: names.get(uid) ?? '' } }).catch((err) =>
    console.error('[bots] interaction dispatch failed:', (err as Error).message)
  );
  void logAction(getDb(), {
    serverId,
    actorUserId: uid,
    action: 'command.invoke',
    targetType: 'bot',
    targetId: bot.id,
    metadata: { channelId, commandName: command.name, interactionId: interaction.id, botName: bot.name },
  }).catch((err) => console.error('[audit] command.invoke failed:', (err as Error).message));

  return NextResponse.json(
    {
      interaction: {
        id: interaction.id,
        status: 'pending',
        commandName: command.name,
        channelId,
        bot: { id: bot.id, name: bot.name },
        expiresAt: interaction.expiresAt.toISOString(),
      },
    },
    { status: 202, headers: { 'Cache-Control': 'no-store' } }
  );
}

export const POST = withApiSecurity(jsonErrors('invoke command', handlePost), {
  allowedMethods: ['POST'],
  maxBodyBytes: 32 * 1024,
  rateLimit: { identifier: 'command-invoke-ip', config: { windowMs: 60_000, maxRequests: 60 } },
});
