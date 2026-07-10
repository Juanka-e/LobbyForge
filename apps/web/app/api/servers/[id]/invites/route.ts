import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CorePermission } from '@lobbyforge/core';
import {
  createInvite,
  getServerById,
  isServerMember,
  listInvitesForServer,
  logAction,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { authorizeServerPermission } from '@/lib/permissions';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CreateInviteSchema = z.object({
  maxUses: z.number().int().positive().max(1000).optional(),
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

function toJson(row: Awaited<ReturnType<typeof listInvitesForServer>>[number]) {
  return {
    id: row.id,
    serverId: row.serverId,
    createdBy: row.createdBy,
    code: row.code,
    maxUses: row.maxUses,
    currentUses: row.currentUses,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
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
      const auth = await authorizeServerPermission(session.uid, serverId, CorePermission.CREATE_INVITE);
      if (!auth.ok) return auth.response;
    }
    const rows = await listInvitesForServer(getDb(), serverId);
    return NextResponse.json(
      { invites: rows.map(toJson) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to list invites' },
      { status: 500 }
    );
  }
}

async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    if (!serverId) {
      return NextResponse.json({ error: 'Server id is required' }, { status: 400 });
    }
    const auth = await authorizeServerPermission(session.uid, serverId, CorePermission.CREATE_INVITE);
    if (!auth.ok) return auth.response;

    let body: z.infer<typeof CreateInviteSchema>;
    try {
      const raw = await req.json().catch(() => ({}));
      body = CreateInviteSchema.parse(raw);
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return NextResponse.json({ error: 'Invalid expiresAt' }, { status: 400 });
    }

    const row = await createInvite(getDb(), {
      serverId,
      createdBy: session.uid,
      maxUses: body.maxUses ?? null,
      expiresAt,
    });
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'invite.create',
      targetType: 'invite',
      targetId: row.id,
      metadata: { code: row.code, maxUses: row.maxUses, expiresAt: row.expiresAt?.toISOString() ?? null },
    }).catch((err) => console.error('[audit] invite.create failed:', (err as Error).message));
    return NextResponse.json({ invite: toJson(row) }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: 'Failed to create invite' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'invites-list', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 1024,
  rateLimit: { identifier: 'invites-create', config: { windowMs: 60_000, maxRequests: 10 } },
});
