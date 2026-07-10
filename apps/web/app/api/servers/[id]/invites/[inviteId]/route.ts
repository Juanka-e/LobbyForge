import { NextResponse } from 'next/server';
import { CorePermission } from '@lobbyforge/core';
import { getInviteById, getServerById, logAction, revokeInvite } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { authorizeServerPermission } from '@/lib/permissions';
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
  ctx: { params: Promise<{ id: string; inviteId: string }> }
): Promise<NextResponse> {
  const { id: serverId, inviteId } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    if (!serverId || !inviteId) {
      return NextResponse.json(
        { error: 'Server id and invite id are required' },
        { status: 400 }
      );
    }
    const auth = await authorizeServerPermission(session.uid, serverId, CorePermission.CREATE_INVITE);
    if (!auth.ok) return auth.response;

    const server = await getServerById(getDb(), serverId);
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    const invite = await getInviteById(getDb(), inviteId);
    if (!invite || invite.serverId !== serverId) {
      return NextResponse.json({ error: 'Invite not found in this server' }, { status: 404 });
    }
    await revokeInvite(getDb(), inviteId);
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'invite.revoke',
      targetType: 'invite',
      targetId: inviteId,
    }).catch((err) => console.error('[audit] invite.revoke failed:', (err as Error).message));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: 'Failed to revoke invite' },
      { status: 500 }
    );
  }
}

export const DELETE = withApiSecurity(handleDelete, {
  allowedMethods: ['DELETE'],
  rateLimit: { identifier: 'invites-revoke', config: { windowMs: 60_000, maxRequests: 10 } },
});
