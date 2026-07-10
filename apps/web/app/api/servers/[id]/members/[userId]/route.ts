import { NextResponse } from 'next/server';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  getServerById,
  getUserPermissions,
  isServerMember,
  logAction,
  removeMember,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

async function handleDelete(
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

    // The owner cannot be kicked (use softDeleteServer or a "transfer
    // ownership" flow instead — both are M14+).
    if (targetUserId === server.ownerUserId) {
      return NextResponse.json(
        { error: 'Cannot kick the server owner' },
        { status: 400 }
      );
    }

    // Self-leave is allowed for any member (no KICK_MEMBERS required).
    if (targetUserId !== session.uid) {
      const permissions = await getUserPermissions(getDb(), session.uid, serverId);
      if (!hasPermission(permissions, CorePermission.KICK_MEMBERS)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    await removeMember(getDb(), serverId, targetUserId);
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: targetUserId === session.uid ? 'member.leave' : 'member.kick',
      targetType: 'user',
      targetId: targetUserId,
    }).catch((err) => console.error('[audit] member.kick failed:', (err as Error).message));
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json(
      { error: 'Failed to remove member' },
      { status: 500 }
    );
  }
}

export const DELETE = withApiSecurity(handleDelete, {
  allowedMethods: ['DELETE'],
  rateLimit: { identifier: 'members-remove', config: { windowMs: 60_000, maxRequests: 20 } },
});
