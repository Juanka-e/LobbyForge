import { NextResponse } from 'next/server';
import { getServerById, isServerMember, listMemberSummariesForServer } from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { toLobbyMember } from '@/lib/lobby-members';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids one request may name — a live event names at most this many. */
const MAX_IDS = 100;

function notFound(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * GET /api/servers/{id}/lobby-members[?ids=a,b,…] — lobby member rows,
 * projected for the viewer exactly like the page render (docs/PROFILES.md
 * "Live updates"): the lobby asks for the members a `members:{serverId}`
 * event named, or for everyone after `roles-changed` or a reconnect.
 *
 * Owner or current member only (one 404 otherwise, like the profile
 * route). Rows come back offline — status is the presence feed's job. A
 * named id that is no longer a member is simply absent; `missing` lists
 * them so the lobby can drop them.
 */
async function handleGet(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  const viewerId = session.session.uid;
  const { id: serverId } = await ctx.params;
  if (!ID_PATTERN.test(serverId ?? '')) return notFound();

  const rawIds = new URL(req.url).searchParams.get('ids');
  let ids: string[] | undefined;
  if (rawIds !== null) {
    ids = [...new Set(rawIds.split(',').map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0 || ids.length > MAX_IDS || !ids.every((id) => ID_PATTERN.test(id))) {
      return NextResponse.json({ error: 'Invalid ids', code: 'invalid_ids' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
    ids = ids.map((id) => id.toLowerCase());
  }

  const db = getDb();
  const server = await getServerById(db, serverId);
  if (!server) return notFound();
  if (server.ownerUserId !== viewerId && !(await isServerMember(db, viewerId, serverId))) return notFound();

  const summaries = await listMemberSummariesForServer(db, serverId, ids ? { userIds: ids } : {});
  const members = summaries.map((summary) => toLobbyMember(summary, viewerId));
  const found = new Set(members.map((member) => member.id));
  return NextResponse.json(
    { members, missing: ids ? ids.filter((id) => !found.has(id)) : [] },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'lobby-members', config: { windowMs: 60_000, maxRequests: 120 } },
});
