import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  setMemberRoles,
  getRoleById,
  logAction,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { authorizeModerationTarget } from '@/lib/member-authorization';
import { publishAccessInvalidation } from '@/lib/access-invalidation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const AssignRoleSchema = z.object({
  roleIds: z.array(z.string().uuid()).max(64),
});

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

async function resolveSession(req: Request): Promise<
  | { ok: true; uid: string }
  | { ok: false; response: NextResponse }
> {
  const secret = getSessionSecret();
  const session = readGuestSession(req.headers.get('cookie'), secret);
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }
  if (!session.uid) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Guest user has no materialized user record', howToFix: 'Re-issue POST /api/auth/guest' },
        { status: 503 }
      ),
    };
  }
  return { ok: true, uid: session.uid };
}

async function handlePut(
  req: Request,
  ctx: { params: Promise<{ id: string; userId: string }> }
): Promise<NextResponse> {
  const { id: serverId, userId: targetUserId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    if (!serverId || !targetUserId) {
      return NextResponse.json(
        { error: 'Server id and user id are required' },
        { status: 400 }
      );
    }
    let body: z.infer<typeof AssignRoleSchema>;
    try {
      const raw = await req.json();
      body = AssignRoleSchema.parse(raw);
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const uniqueRoleIds = Array.from(new Set(body.roleIds));

    // LF-SEC-004: canonical moderation gate — MANAGE_ROLES + the actor
    // must strictly outrank the TARGET (the old code only checked the
    // assigned roles against the actor, so a lower role manager could
    // strip a higher-ranked user's roles with roleIds: []). Only the
    // owner may change the owner's roles; ADMINISTRATOR never bypasses
    // ranking. The helper also verifies the target is a member.
    const gate = await authorizeModerationTarget({
      operation: 'set_roles',
      serverId,
      actorUserId: session.uid,
      targetUserId,
    });
    if (!gate.ok) return gate.response;

    // Assigned roles must sit STRICTLY below the actor's highest role
    // (owner assigns freely — but roles must still exist in this server).
    if (session.uid !== gate.context.server.ownerUserId) {
      for (const roleId of uniqueRoleIds) {
        const role = await getRoleById(getDb(), roleId);
        if (!role || role.serverId !== serverId) {
          return NextResponse.json({ error: 'Role not found in this server' }, { status: 404 });
        }
        if (role.position >= gate.context.actorHighest) {
          return NextResponse.json(
            { error: `You can only assign roles below your highest role (role "${role.name}" is at or above it)` },
            { status: 403 }
          );
        }
      }
    } else {
      for (const roleId of uniqueRoleIds) {
        const role = await getRoleById(getDb(), roleId);
        if (!role || role.serverId !== serverId) {
          return NextResponse.json({ error: 'Role not found in this server' }, { status: 404 });
        }
      }
    }

    const updated = await setMemberRoles(getDb(), serverId, targetUserId, uniqueRoleIds);
    // LF-SEC-003: role changes must invalidate the target's LIVE
    // subscriptions (private-channel access may have just changed).
    publishAccessInvalidation({
      kind: 'user-server-access',
      serverId,
      userId: targetUserId,
      reason: 'roles_changed',
    });
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'member.set_roles',
      targetType: 'membership',
      targetId: targetUserId,
      metadata: { roleIds: uniqueRoleIds },
    }).catch((err) => console.error('[audit] member.set_roles failed:', (err as Error).message));
    return NextResponse.json(
      {
        membership: {
          serverId: updated.serverId,
          userId: updated.userId,
          roleId: updated.roleId,
          roleIds: uniqueRoleIds,
          nickname: updated.nickname,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to assign role' },
      { status: 500 }
    );
  }
}

export const PUT = withApiSecurity(handlePut, {
  allowedMethods: ['PUT'],
  maxBodyBytes: 4096,
  rateLimit: { identifier: 'members-assign-role', config: { windowMs: 60_000, maxRequests: 20 } },
});
