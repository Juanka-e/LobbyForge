/**
 * Canonical member/moderation hierarchy (LF-SEC-004 + LF-SEC-005).
 *
 * The 8th audit found the SAME rule implemented inconsistently across
 * sibling routes: timeout checked actor-vs-target hierarchy, role
 * assignment only checked assigned-role-vs-actor, and kick/ban checked
 * nothing — so a lower-ranked moderator could strip a higher-ranked
 * user's roles or kick/ban them. Every moderation surface now funnels
 * through ONE helper so the semantics cannot diverge again:
 *
 *   owner actor        → bypasses hierarchy (but never acts on the owner)
 *   target is owner    → rejected for every non-owner actor
 *   actor === target   → rejected EXCEPT kick's self-leave path (the
 *                        kick route handles self-leave before calling)
 *   otherwise          → actorHighest must be STRICTLY above targetHighest
 *
 * Operation permission mapping lives here too, so a route cannot pair
 * the wrong permission with the wrong action.
 */
import { NextResponse } from 'next/server';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  getHighestRolePosition,
  getServerById,
  getUserPermissions,
  isServerMember,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';

export type ModerationOperation = 'kick' | 'ban' | 'timeout' | 'set_roles';

const OPERATION_PERMISSION: Record<ModerationOperation, CorePermission> = {
  kick: CorePermission.KICK_MEMBERS,
  ban: CorePermission.BAN_MEMBERS,
  timeout: CorePermission.MODERATE_MEMBERS,
  set_roles: CorePermission.MANAGE_ROLES,
};

const OPERATION_LABEL: Record<ModerationOperation, string> = {
  kick: 'kick',
  ban: 'ban',
  timeout: 'time out',
  set_roles: 'manage the roles of',
};

export interface ModerationAuthContext {
  server: { id: string; ownerUserId: string };
  /** The actor's highest role position — role assignment reuses it to
   * also require every ASSIGNED role to sit strictly below the actor. */
  actorHighest: number;
}

/**
 * Pure hierarchy check: actor's highest role strictly above the
 * target's. Exposed separately for callers that already hold both
 * positions.
 */
export function isActorAboveTarget(actorHighest: number, targetHighest: number): boolean {
  return actorHighest > targetHighest;
}

/**
 * Full moderation-target authorization: server exists, actor is a
 * member with the operation's permission, self-action and owner
 * protection apply, the target is a member, and the actor outranks the
 * target. Kick's self-leave semantics are handled by the kick route
 * BEFORE calling this helper.
 */
export async function authorizeModerationTarget(input: {
  operation: ModerationOperation;
  serverId: string;
  actorUserId: string;
  targetUserId: string;
}): Promise<
  | { ok: true; context: ModerationAuthContext }
  | { ok: false; response: NextResponse }
> {
  const { operation, serverId, actorUserId, targetUserId } = input;
  if (!serverId || !actorUserId || !targetUserId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Server and user ids are required' }, { status: 400 }),
    };
  }

  const server = await getServerById(getDb(), serverId);
  if (!server) {
    return { ok: false, response: NextResponse.json({ error: 'Server not found' }, { status: 404 }) };
  }

  const actorIsOwner = server.ownerUserId === actorUserId;
  if (!actorIsOwner && !(await isServerMember(getDb(), actorUserId, serverId))) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  const permissions = await getUserPermissions(getDb(), actorUserId, serverId);
  if (!actorIsOwner && !hasPermission(permissions, OPERATION_PERMISSION[operation])) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  // Self-action: never moderate yourself through these routes (kick's
  // self-leave path never reaches here; leaving is handled there).
  if (actorUserId === targetUserId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'You cannot perform this action on yourself' }, { status: 400 }),
    };
  }

  // The owner is protected from every moderation action by anyone else.
  if (targetUserId === server.ownerUserId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `The server owner cannot be ${OPERATION_LABEL[operation] === 'kick' ? 'kicked' : OPERATION_LABEL[operation] === 'ban' ? 'banned' : 'targeted'} by this action` },
        { status: 403 }
      ),
    };
  }

  if (!(await isServerMember(getDb(), targetUserId, serverId))) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Target user is not a member of this server' }, { status: 404 }),
    };
  }

  // Owner bypasses ranking entirely; everyone else must strictly
  // outrank the target (equal rank cannot moderate equal rank).
  if (actorIsOwner) {
    return { ok: true, context: { server, actorHighest: Number.POSITIVE_INFINITY } };
  }

  const [actorHighest, targetHighest] = await Promise.all([
    getHighestRolePosition(getDb(), serverId, actorUserId, server.ownerUserId),
    getHighestRolePosition(getDb(), serverId, targetUserId, server.ownerUserId),
  ]);
  if (!isActorAboveTarget(actorHighest, targetHighest)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `You can only ${OPERATION_LABEL[operation]} members below your highest role` },
        { status: 403 }
      ),
    };
  }

  return { ok: true, context: { server, actorHighest } };
}
