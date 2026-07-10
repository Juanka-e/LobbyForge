import { NextResponse } from 'next/server';
import { CorePermission } from '@lobbyforge/core';
import {
  getServerById,
  isServerMember,
  listAuditLogsForServer,
} from '@lobbyforge/db';
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

function toJson(row: Awaited<ReturnType<typeof listAuditLogsForServer>>[number]) {
  return {
    id: row.id,
    serverId: row.serverId,
    actorUserId: row.actorUserId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}

async function handleGet(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const server = await getServerById(getDb(), serverId);
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    // Owner is always allowed to read; for non-owners, require membership.
    if (server.ownerUserId !== session.uid) {
      if (!(await isServerMember(getDb(), session.uid, serverId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
    // Reading the audit log is gated behind VIEW_AUDIT_LOG so the
    // owner can keep the "who kicked who" history private from regular
    // members. The owner always passes the check via the ADMINISTRATOR
    // permission seeded by getUserPermissions' owner shortcut.
    const auth = await authorizeServerPermission(session.uid, serverId, CorePermission.VIEW_AUDIT_LOG);
    if (!auth.ok) return auth.response;

    const url = new URL(req.url);
    const beforeParam = url.searchParams.get('before');
    const before = beforeParam ? new Date(beforeParam) : undefined;
    if (beforeParam && (!before || Number.isNaN(before.getTime()))) {
      return NextResponse.json({ error: 'Invalid `before` cursor' }, { status: 400 });
    }
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.max(1, Math.min(200, Number.parseInt(limitParam, 10))) : 100;
    if (limitParam && (!Number.isFinite(limit) || String(limit) !== limitParam)) {
      return NextResponse.json({ error: 'Invalid `limit`' }, { status: 400 });
    }

    const rows = await listAuditLogsForServer(getDb(), serverId, {
      ...(before ? { before } : {}),
      limit,
    });
    return NextResponse.json(
      { auditLogs: rows.map(toJson) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to list audit logs' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'audit-logs-list', config: { windowMs: 60_000, maxRequests: 60 } },
});
