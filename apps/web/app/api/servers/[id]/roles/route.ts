import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  createRole,
  getHighestRolePosition,
  getServerById,
  getUserPermissions,
  isServerMember,
  listRolesForServer,
  logAction,
  type RoleRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { isValidRoleIcon } from '@/lib/role-icons';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KNOWN_PERMISSIONS = new Set<string>(Object.values(CorePermission));

const CreateRoleSchema = z.object({
  name: z.string().min(1).max(64),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().refine(isValidRoleIcon, 'Icon must be a supported Material name or a single emoji').nullable().optional(),
  displaySeparately: z.boolean().optional(),
  position: z.number().int().min(0).max(1_000_000).optional(),
  permissions: z.array(z.string()).max(64),
});

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

function toJson(role: RoleRow): Record<string, unknown> {
  return {
    id: role.id,
    serverId: role.serverId,
    name: role.name,
    color: role.color,
    icon: role.icon,
    displaySeparately: role.displaySeparately,
    position: role.position,
    permissions: role.permissions,
    createdAt: role.createdAt.toISOString(),
  };
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

async function assertReadable(serverId: string, userId: string): Promise<NextResponse | null> {
  if (!serverId) {
    return NextResponse.json({ error: 'Server id is required' }, { status: 400 });
  }
  const server = await getServerById(getDb(), serverId);
  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }
  if (server.ownerUserId === userId) return null;
  if (!(await isServerMember(getDb(), userId, serverId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}

async function handleGet(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const gate = await assertReadable(serverId, session.uid);
    if (gate) return gate;

    const rows = await listRolesForServer(getDb(), serverId);
    return NextResponse.json(
      { roles: rows.map(toJson) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to list roles' },
      { status: 500 }
    );
  }
}

async function handlePost(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const gate = await assertReadable(serverId, session.uid);
    if (gate) return gate;

    const permissions = await getUserPermissions(getDb(), session.uid, serverId);
    if (!hasPermission(permissions, CorePermission.MANAGE_ROLES)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    let body: z.infer<typeof CreateRoleSchema>;
    try {
      const raw = await req.json();
      body = CreateRoleSchema.parse(raw);
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    // Reject unknown permissions so the role doesn't accidentally grant
    // a typo'd permission (and the JSONB column stays clean).
    const unknown = body.permissions.filter((p) => !KNOWN_PERMISSIONS.has(p));
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: 'Unknown permissions in request', unknown },
        { status: 400 }
      );
    }

    // Discord-style hierarchy on CREATE: a non-owner cannot birth a role
    // at/past their own rank (that would be gifting themselves a
    // promotion). ADMINISTRATOR does not bypass; only the owner does.
    const server = await getServerById(getDb(), serverId);
    if (server && session.uid !== server.ownerUserId) {
      const actorHighest = await getHighestRolePosition(getDb(), serverId, session.uid);
      const requested = body.position ?? 0;
      if (requested >= actorHighest) {
        return NextResponse.json(
          { error: 'You cannot create a role at or above your highest role' },
          { status: 403 }
        );
      }
    }

    const role = await createRole(getDb(), {
      serverId,
      name: body.name,
      ...(body.color !== undefined ? { color: body.color } : {}),
      ...(body.icon !== undefined ? { icon: body.icon } : {}),
      ...(body.displaySeparately !== undefined ? { displaySeparately: body.displaySeparately } : {}),
      ...(body.position !== undefined ? { position: body.position } : {}),
      permissions: body.permissions,
    });
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'role.create',
      targetType: 'role',
      targetId: role.id,
      metadata: { name: body.name, permissions: body.permissions },
    }).catch((err) => console.error('[audit] role.create failed:', (err as Error).message));
    return NextResponse.json(
      { role: toJson(role) },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to create role' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'roles-list', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'roles-create', config: { windowMs: 60_000, maxRequests: 10 } },
});
