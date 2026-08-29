import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  setMemberRoles,
  getRoleById,
  getHighestRolePosition,
  getServerById,
  getUserPermissions,
  isServerMember,
  logAction,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';

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
    const server = await getServerById(getDb(), serverId);
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    if (!(await isServerMember(getDb(), session.uid, serverId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const permissions = await getUserPermissions(getDb(), session.uid, serverId);
    if (!hasPermission(permissions, CorePermission.MANAGE_ROLES)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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

    // Discord-style hierarchy:
    //  - Only the OWNER may change the owner's roles (admins cannot).
    //  - ADMINISTRATOR does NOT bypass ranking: everyone else may only
    //    assign roles STRICTLY BELOW their own highest role.
    if (targetUserId === server.ownerUserId && session.uid !== server.ownerUserId) {
      return NextResponse.json(
        { error: "Only the server owner can change the owner's roles" },
        { status: 403 }
      );
    }
    if (session.uid !== server.ownerUserId) {
      const actorHighest = await getHighestRolePosition(getDb(), serverId, session.uid);
      for (const roleId of uniqueRoleIds) {
        const role = await getRoleById(getDb(), roleId);
        if (!role || role.serverId !== serverId) {
          return NextResponse.json({ error: 'Role not found in this server' }, { status: 404 });
        }
        if (role.position >= actorHighest) {
          return NextResponse.json(
            { error: `You can only assign roles below your highest role (role "${role.name}" is at or above it)` },
            { status: 403 }
          );
        }
      }
    } else {
      // Owner assigns freely — still verify the roles exist in this server.
      for (const roleId of uniqueRoleIds) {
        const role = await getRoleById(getDb(), roleId);
        if (!role || role.serverId !== serverId) {
          return NextResponse.json({ error: 'Role not found in this server' }, { status: 404 });
        }
      }
    }

    // Verify the target user is actually a member of this server before
    // assigning roles. Without this, an admin can create role assignments
    // for arbitrary user IDs (including users who never joined).
    const targetIsMember = server.ownerUserId === targetUserId || await isServerMember(getDb(), targetUserId, serverId);
    if (!targetIsMember) {
      return NextResponse.json({ error: 'Target user is not a member of this server' }, { status: 404 });
    }

    const updated = await setMemberRoles(getDb(), serverId, targetUserId, uniqueRoleIds);
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
