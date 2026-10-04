import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getMemberRoleIds, getServerMember, listRolesForServer, listUserDisplayNames, type BotRow } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withMachineApiSecurity } from '@/lib/security-headers';
import { botApiOptions, botApiRoute, botError, withBotAuth } from '@/lib/bots/api';
import { V2_READ_LIMIT, requireBotPermission } from '../../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ userId: string }> };

const NOT_FOUND = () => botError(404, 'not_found', 'Member not found');

/**
 * GET /api/bot/v2/members/{userId} — one member of the bot's server:
 * `{ member: { id, displayName, nickname, roles: [{ id, name }], joinedAt } }`.
 * Needs `read_members`. Only what every member already sees in the member
 * list — never an e-mail, avatar data or permissions. Someone who is not a
 * member of THIS server is 404, whether or not the account exists.
 */
async function handleGet(_req: Request, ctx: RouteContext, bot: BotRow): Promise<NextResponse> {
  const denied = requireBotPermission(bot, 'read_members');
  if (denied) return denied;
  const { userId } = await ctx.params;
  if (!z.string().uuid().safeParse(userId).success) return NOT_FOUND();
  const membership = await getServerMember(getDb(), bot.serverId, userId);
  if (!membership) return NOT_FOUND();
  const [names, roleIds, roles] = await Promise.all([
    listUserDisplayNames(getDb(), [userId]),
    getMemberRoleIds(getDb(), bot.serverId, userId),
    listRolesForServer(getDb(), bot.serverId),
  ]);
  const held = new Set(roleIds);
  return NextResponse.json({
    member: {
      id: userId,
      displayName: names.get(userId) ?? null,
      nickname: membership.nickname,
      roles: roles
        .filter((role) => held.has(role.id))
        .sort((a, b) => b.position - a.position)
        .map((role) => ({ id: role.id, name: role.name })),
      joinedAt: membership.createdAt.toISOString(),
    },
  });
}

export const GET = botApiRoute(
  withMachineApiSecurity(withBotAuth(handleGet), botApiOptions(['GET'], 'v2-members', V2_READ_LIMIT))
);
