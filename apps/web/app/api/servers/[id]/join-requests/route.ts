import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserPermissions, listJoinRequestsForServer } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { CorePermission, hasPermission, requireMaterializedSession, requireServerMember } from '@/lib/api-auth';
import { canReviewJoinRequests, isUuid, toJoinRequestJson } from '@/lib/join-requests';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const QuerySchema = z.object({
  status: z.enum(['pending', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

/**
 * GET /api/servers/{id}/join-requests — the approval queue for moderators
 * (KICK_MEMBERS or MANAGE_SERVER, see lib/join-requests.ts). Pending
 * requests first, oldest first; `?status=all` appends decided ones, newest
 * decision first. Paginated with `limit` (≤ 100) and `offset`. A server id
 * that is not a UUID is answered 404 before it reaches Postgres.
 */
async function handleGet(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  const uid = session.session.uid;
  if (!isUuid(serverId)) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  const url = new URL(req.url);
  const query = QuerySchema.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json({ error: 'Invalid query' }, { status: 400 });
  }

  try {
    const member = await requireServerMember(uid, serverId);
    if (!member.ok) return member.response;
    const permissions = await getUserPermissions(getDb(), uid, serverId);
    if (!canReviewJoinRequests(permissions)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const includeInviteCode = hasPermission(permissions, CorePermission.MANAGE_SERVER);
    const page = await listJoinRequestsForServer(getDb(), serverId, query.data);
    return NextResponse.json(
      {
        requests: page.requests.map((row) => toJoinRequestJson(row, { includeInviteCode })),
        pendingCount: page.pendingCount,
        nextOffset: page.nextOffset,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ error: 'Failed to list join requests' }, { status: 500 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'server-join-requests-list', config: { windowMs: 60_000, maxRequests: 60 } },
});
