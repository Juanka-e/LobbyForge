import { NextResponse } from 'next/server';
import { logAction, redeemInvite } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { normalizeInviteCode } from '@/lib/invite-code';
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

async function handlePost(req: Request, ctx: { params: Promise<{ code: string }> }): Promise<NextResponse> {
  const { code: rawCode } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const code = normalizeInviteCode(rawCode ?? '');
    if (!code) {
      return NextResponse.json({ error: 'Invalid invite code' }, { status: 400 });
    }
    const result = await redeemInvite(getDb(), code, session.uid);
    if (result.ok) {
      void logAction(getDb(), {
        serverId: result.serverId,
        actorUserId: session.uid,
        action: 'invite.redeem',
        targetType: 'membership',
        targetId: result.membershipId,
        metadata: { code, roleId: result.roleId },
      }).catch((err) => console.error('[audit] invite.redeem failed:', (err as Error).message));
      return NextResponse.json(
        {
          membership: {
            serverId: result.serverId,
            userId: session.uid,
            roleId: result.roleId,
            roleIds: [result.roleId],
          },
        },
        { status: 201 }
      );
    }
    // Map the discriminated error to a status code.
    switch (result.error) {
      case 'not_found':
      case 'expired':
      case 'exhausted':
        return NextResponse.json({ error: 'Invite is unavailable' }, { status: 403 });
      case 'already_member':
        return NextResponse.json({ error: 'You are already a member of this server' }, { status: 409 });
      case 'no_everyone_role':
        return NextResponse.json(
          { error: 'Server is missing the @everyone role. This is a server-side bug.' },
          { status: 500 }
        );
      case 'banned':
        return NextResponse.json(
          { error: 'You are banned from this server' },
          { status: 403 }
        );
    }
  } catch {
    return NextResponse.json(
      { error: 'Failed to redeem invite' },
      { status: 500 }
    );
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 0,
  rateLimit: { identifier: 'invite-redeem', config: { windowMs: 60_000, maxRequests: 10 } },
});
