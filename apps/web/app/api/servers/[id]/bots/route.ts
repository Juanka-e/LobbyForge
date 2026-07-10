import { NextResponse } from 'next/server';
import { listBotsForServer } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession, requireServerMember } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function toJson(row: Awaited<ReturnType<typeof listBotsForServer>>[number]) {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    type: row.type,
    permissions: row.permissions,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    tokenConfigured: Boolean(row.tokenHash),
    trustLevel: row.type.startsWith('internal') || row.type.startsWith('plugin')
      ? 'official'
      : 'unverified',
  };
}

async function handleGet(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  const member = await requireServerMember(session.session.uid, serverId);
  if (!member.ok) return member.response;

  const rows = await listBotsForServer(getDb(), serverId);
  return NextResponse.json(
    { bots: rows.map(toJson) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'server-bots-list', config: { windowMs: 60_000, maxRequests: 60 } },
});
