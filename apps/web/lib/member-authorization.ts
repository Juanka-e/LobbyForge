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
 *   timed-out actor    → rejected (403 `actor_timed_out`); never the owner
 *   target is owner    → rejected for every non-owner actor
 *   actor === target   → rejected EXCEPT kick's self-leave path (the
 *                        kick route handles self-leave before calling)
 *   otherwise          → actorHighest must be STRICTLY above targetHighest
 *
 * Operation permission mapping lives here too, so a route cannot pair
 * the wrong permission with the wrong action.
 */
import { NextResponse } from 'next/server';
import { hasPermission } from '@lobbyforge/core';
import {
  getActiveMemberTimeout,
  getHighestRolePosition,
  getServerById,
  getUserPermissions,
  isServerMember,
  userExists,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
// The permission map and the rank comparison are shared with the profile
// card's `viewerCan` (lib/member-capabilities.ts), so what the card offers
// and what this gate accepts cannot drift apart.
import {
  isActorAboveTarget,
  MODERATION_OPERATION_PERMISSION as OPERATION_PERMISSION,
  type ModerationOperation,
} from '@/lib/member-capabilities';

export { isActorAboveTarget, type ModerationOperation };

const OPERATION_LABEL: Record<ModerationOperation, string> = {
  kick: 'kick',
  ban: 'ban',
  timeout: 'time out',
  set_roles: 'manage the roles of',
  voice_mute: 'voice-mute',
  voice_disconnect: 'disconnect from voice',
};

/**
 * Machine-readable reason on every refusal below (`{ error, code }`), so
 * a client can say it in the viewer's language instead of showing the
 * English `error`.
 */
export type ModerationRefusalCode =
  | 'invalid_request'
  | 'server_not_found'
  | 'forbidden'
  | 'self_action'
  | 'target_is_owner'
  | 'user_not_found'
  | 'target_not_member'
  | 'insufficient_rank'
  | 'actor_timed_out';

function refuse(error: string, code: ModerationRefusalCode, status: number): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error, code }, { status }) };
}

export interface ModerationAuthContext {
  server: { id: string; ownerUserId: string };
  /** The actor's highest role position — role assignment reuses it to
   * also require every ASSIGNED role to sit strictly below the actor. */
  actorHighest: number;
}

/**
 * Full moderation-target authorization: server exists, actor is a
 * member with the operation's permission, self-action and owner
 * protection apply, the target is a member, and the actor outranks the
 * target. A BAN may also target an existing user who is not a member
 * (no rank comparison then — security-review AUTHZ-002). Kick's
 * self-leave semantics are handled by the kick route BEFORE calling
 * this helper.
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
    return refuse('Server and user ids are required', 'invalid_request', 400);
  }

  const server = await getServerById(getDb(), serverId);
  if (!server) {
    return refuse('Server not found', 'server_not_found', 404);
  }

  const actorIsOwner = server.ownerUserId === actorUserId;
  if (!actorIsOwner && !(await isServerMember(getDb(), actorUserId, serverId))) {
    return refuse('Forbidden', 'forbidden', 403);
  }

  const permissions = await getUserPermissions(getDb(), actorUserId, serverId);
  if (!actorIsOwner && !hasPermission(permissions, OPERATION_PERMISSION[operation])) {
    return refuse('Forbidden', 'forbidden', 403);
  }

  // Security review (needs verification #4): a timed-out moderator could
  // still kick, ban, time out, mute, disconnect and re-role others — a
  // timeout silences a member in every other way (messages, invites,
  // voice). The owner cannot be timed out by anyone, so is never refused.
  if (!actorIsOwner) {
    const timedOutUntil = await getActiveMemberTimeout(getDb(), serverId, actorUserId);
    if (timedOutUntil) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'You are timed out in this server', code: 'actor_timed_out', until: timedOutUntil.toISOString() },
          { status: 403 }
        ),
      };
    }
  }

  // Self-action: never moderate yourself through these routes (kick's
  // self-leave path never reaches here; leaving is handled there).
  if (actorUserId === targetUserId) {
    return refuse('You cannot perform this action on yourself', 'self_action', 400);
  }

  // The owner is protected from every moderation action by anyone else.
  if (targetUserId === server.ownerUserId) {
    return refuse(
      `The server owner cannot be ${OPERATION_LABEL[operation] === 'kick' ? 'kicked' : OPERATION_LABEL[operation] === 'ban' ? 'banned' : 'targeted'} by this action`,
      'target_is_owner',
      403
    );
  }

  if (!(await isServerMember(getDb(), targetUserId, serverId))) {
    // security-review AUTHZ-002: a ban must reach a user who is not (or
    // no longer) a member — someone who left to dodge a moderator, or a
    // known troublemaker before they join. The actor's BAN_MEMBERS, the
    // owner protection and the self check above still apply; there is no
    // rank to compare (a non-member holds no roles). Kick, timeout, mute
    // and role changes act on a membership and keep requiring one.
    if (operation === 'ban') {
      // security-review FILE-001: an existence check selects the id only,
      // not the target's row with its avatar / banner data URLs.
      if (!(await userExists(getDb(), targetUserId))) {
        return refuse('User not found', 'user_not_found', 404);
      }
      const actorHighest = actorIsOwner
        ? Number.POSITIVE_INFINITY
        : await getHighestRolePosition(getDb(), serverId, actorUserId, server.ownerUserId);
      return { ok: true, context: { server, actorHighest } };
    }
    return refuse('Target user is not a member of this server', 'target_not_member', 404);
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
    return refuse(`You can only ${OPERATION_LABEL[operation]} members below your highest role`, 'insufficient_rank', 403);
  }

  return { ok: true, context: { server, actorHighest } };
}
