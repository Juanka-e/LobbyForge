import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  banUser,
  getServerById,
  getUserPermissions,
  isServerMember,
  isCurrentlyBanned,
  listBansForServer,
  logAction,
  unbanUser,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BanBodySchema = z.object({
  userId: z.string().uuid(),
  reason: z.string().max(512).optional(),
  expiresAt: z.string().datetime().optional(),
});

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

function toJson(row: Awaited<ReturnType<typeof listBansForServer>>[number]) {
  return {
    id: row.id,
    serverId: row.serverId,
    userId: row.userId,
    bannedBy: row.bannedBy,
    reason: row.reason,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    displayName: row.displayName,
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
    if (server.ownerUserId !== session.uid) {
      if (!(await isServerMember(getDb(), session.uid, serverId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
    const bans = await listBansForServer(getDb(), serverId);
    return NextResponse.json(
      { bans: bans.map(toJson) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to list bans' },
      { status: 500 }
    );
  }
}

async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const server = await getServerById(getDb(), serverId);
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    const permissions = await getUserPermissions(getDb(), session.uid, serverId);
    if (!hasPermission(permissions, CorePermission.BAN_MEMBERS)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    let body: z.infer<typeof BanBodySchema>;
    try {
      const raw = await req.json();
      body = BanBodySchema.parse(raw);
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    if (body.userId === server.ownerUserId) {
      return NextResponse.json({ error: 'Cannot ban the server owner' }, { status: 400 });
    }

    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return NextResponse.json({ error: 'Invalid expiresAt' }, { status: 400 });
    }

    const result = await banUser(getDb(), {
      serverId,
      userId: body.userId,
      bannedBy: session.uid,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    });
    if (!result.ok) {
      switch (result.error) {
        case 'cannot_ban_self':
          return NextResponse.json({ error: 'You cannot ban yourself' }, { status: 400 });
        case 'cannot_ban_owner':
          return NextResponse.json({ error: 'Cannot ban the server owner' }, { status: 400 });
        case 'already_banned':
          return NextResponse.json({ error: 'User is already banned' }, { status: 409 });
      }
    }
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'ban.create',
      targetType: 'user',
      targetId: body.userId,
      metadata: { reason: body.reason ?? null, expiresAt: expiresAt?.toISOString() ?? null },
    }).catch((err) => console.error('[audit] ban.create failed:', (err as Error).message));
    return NextResponse.json({ ban: toJson({ ...result.ban, displayName: null }) }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: 'Failed to create ban' },
      { status: 500 }
    );
  }
}

async function handleDelete(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  // `DELETE /api/servers/{id}/bans` is a bulk-unban for a single user; the
  // path encodes which user via a `userId` query param. (The other shape
  // — `/api/servers/{id}/bans/{banId}` — is a follow-up.)
  const { id: serverId } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const url = new URL(req.url);
    const userId = url.searchParams.get('userId');
    if (!userId) {
      return NextResponse.json({ error: 'userId query parameter is required' }, { status: 400 });
    }
    if (!/^[0-9a-f-]{36}$/i.test(userId)) {
      return NextResponse.json({ error: 'Invalid userId' }, { status: 400 });
    }

    const server = await getServerById(getDb(), serverId);
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    const permissions = await getUserPermissions(getDb(), session.uid, serverId);
    if (!hasPermission(permissions, CorePermission.BAN_MEMBERS)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const stillBanned = await isCurrentlyBanned(getDb(), serverId, userId);
    if (!stillBanned) {
      return NextResponse.json({ ok: true, removed: false });
    }
    await unbanUser(getDb(), serverId, userId);
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'ban.remove',
      targetType: 'user',
      targetId: userId,
    }).catch((err) => console.error('[audit] ban.remove failed:', (err as Error).message));
    return NextResponse.json({ ok: true, removed: true });
  } catch {
    return NextResponse.json(
      { error: 'Failed to remove ban' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'bans-list', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 2048,
  rateLimit: { identifier: 'bans-create', config: { windowMs: 60_000, maxRequests: 10 } },
});

export const DELETE = withApiSecurity(handleDelete, {
  allowedMethods: ['DELETE'],
  maxBodyBytes: 1024,
  rateLimit: { identifier: 'bans-remove', config: { windowMs: 60_000, maxRequests: 10 } },
});
