import { NextResponse } from 'next/server';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  getServerById,
  isServerMember,
  listMembersForServer,
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

async function handleGet(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    if (!serverId) {
      return NextResponse.json({ error: 'Server id is required' }, { status: 400 });
    }
    const server = await getServerById(getDb(), serverId);
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    if (server.ownerUserId !== session.uid) {
      if (!(await isServerMember(getDb(), session.uid, serverId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const members = await listMembersForServer(getDb(), serverId);
    // Decorate the owner with the implicit ADMINISTRATOR permission so the
    // UI can render the "Owner" badge without doing the lookup itself.
    const decorated = members.map((m) => {
      if (m.userId === server.ownerUserId) {
        const set = new Set<string>(m.permissions);
        set.add(CorePermission.ADMINISTRATOR);
        return { ...m, permissions: Array.from(set), isOwner: true };
      }
      return { ...m, isOwner: false };
    });

    return NextResponse.json(
      { members: decorated },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to list members' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'members-list', config: { windowMs: 60_000, maxRequests: 60 } },
});

// `hasPermission` is used by the role/membership routes to gate the
// MANAGE_ROLES / KICK_MEMBERS checks. Re-export the union so the call
// sites that import `hasPermission` from this module don't have to
// import core twice.
void hasPermission;
