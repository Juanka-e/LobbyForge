import { NextResponse } from 'next/server';
import {
  getGameSessionById,
  getServerById,
  isServerMember,
  listPlayersForSession,
  users,
} from '@lobbyforge/db';
import { asc, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { getPluginServer } from '@/lib/plugin-server-registry';

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

async function handleGet(
  _req: Request,
  ctx: { params: Promise<{ id: string; sessionId: string }> }
): Promise<NextResponse> {
  const { id: serverId, sessionId } = await ctx.params;
  const session = await resolveSession(_req);
  if (!session.ok) return session.response;

  try {
    const server = await getServerById(getDb(), serverId);
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    if (server.ownerUserId !== session.uid) {
      if (!(await isServerMember(getDb(), session.uid, serverId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
    const row = await getGameSessionById(getDb(), sessionId);
    if (!row) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 });
    }
    if (row.serverId !== serverId) {
      // Defence-in-depth — the path encodes the server, but a
      // caller shouldn't be able to read another server's session
      // by guessing the sessionId.
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 });
    }
    const players = await listPlayersForSession(getDb(), sessionId);
    // Join with users to include the display name in the player list so
    // the plugin's renderClient can show "Explainer: Alice" instead of
    // "Explainer: u-abcdef". One round-trip with a single IN.
    const playerUserIds = players.map((p) => p.userId);
    const userRows =
      playerUserIds.length === 0
        ? []
        : await getDb()
            .select({ id: users.id, displayName: users.displayName })
            .from(users)
            .where(inArray(users.id, playerUserIds))
            .orderBy(asc(users.displayName));
    const userById = new Map(userRows.map((u) => [u.id, u.displayName]));

    // State versioning: if the registered plugin exposes a
    // `migrateState(raw)`, run it on the persisted JSONB so the
    // panel + reducer see the current shape even when the row was
    // written by an older build. The migrator is idempotent; it's
    // safe to run on every read.
    const plugin = getPluginServer(row.pluginId);
    const state = plugin?.migrateState ? plugin.migrateState(row.state) : row.state;

    return NextResponse.json(
      {
        activity: {
          id: row.id,
          serverId: row.serverId,
          channelId: row.channelId,
          pluginId: row.pluginId,
          status: row.status,
          state,
          publicSummary: row.publicSummary,
          createdBy: row.createdBy,
          createdAt: row.createdAt.toISOString(),
          startedAt: row.startedAt ? row.startedAt.toISOString() : null,
          players: players.map((p) => ({
            userId: p.userId,
            name: userById.get(p.userId) ?? null,
            status: p.status,
            score: p.score,
            joinedAt: p.joinedAt.toISOString(),
          })),
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to load activity' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'activity-get', config: { windowMs: 60_000, maxRequests: 60 } },
});
