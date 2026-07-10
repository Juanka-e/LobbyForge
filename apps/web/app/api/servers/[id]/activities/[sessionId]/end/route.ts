import { NextResponse } from 'next/server';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  endGameSession,
  getGameSessionById,
  getServerById,
  getUserPermissions,
  logAction,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { publishActivityStateChange } from '@/lib/activity-bus';

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

async function handlePost(
  req: Request,
  ctx: { params: Promise<{ id: string; sessionId: string }> }
): Promise<NextResponse> {
  const { id: serverId, sessionId } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const server = await getServerById(getDb(), serverId);
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    const row = await getGameSessionById(getDb(), sessionId);
    if (!row) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 });
    }
    if (row.serverId !== serverId) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 });
    }

    // The host can end its own session; otherwise the caller needs
    // START_ACTIVITY.
    const isHost = row.createdBy === session.uid;
    if (!isHost) {
      const permissions = await getUserPermissions(getDb(), session.uid, serverId);
      if (!hasPermission(permissions, CorePermission.START_ACTIVITY)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const ended = await endGameSession(getDb(), sessionId);
    if (ended) {
      publishActivityStateChange({
        serverId,
        sessionId,
        status: ended.status,
        state: ended.state,
        publicSummary: ended.publicSummary,
      });
    }
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'activity.end',
      targetType: 'session',
      targetId: sessionId,
      metadata: { pluginId: row.pluginId, wasHost: isHost },
    }).catch((err) => console.error('[audit] activity.end failed:', (err as Error).message));
    return NextResponse.json(
      { activity: ended && { id: ended.id, status: ended.status, endedAt: ended.endedAt?.toISOString() ?? null } },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to end activity' },
      { status: 500 }
    );
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'activity-end', config: { windowMs: 60_000, maxRequests: 10 } },
});
