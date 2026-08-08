import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  EVERYONE_ROLE_NAME,
  deleteRole,
  getRoleById,
  getServerById,
  getUserPermissions,
  isServerMember,
  logAction,
  updateRole,
  type RoleRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { ROLE_ICONS } from '@/lib/role-icons';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KNOWN_PERMISSIONS = new Set<string>(Object.values(CorePermission));

const PatchRoleSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  icon: z.enum(ROLE_ICONS).nullable().optional(),
  displaySeparately: z.boolean().optional(),
  position: z.number().int().min(0).max(1_000_000).optional(),
  permissions: z.array(z.string()).max(64).optional(),
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

interface AuthContext {
  ok: true;
  role: RoleRow;
}
type AuthError = { ok: false; response: NextResponse };

async function loadRoleForRead(serverId: string, roleId: string, userId: string): Promise<AuthContext | AuthError> {
  if (!serverId || !roleId) {
    return { ok: false, response: NextResponse.json({ error: 'Server id and role id are required' }, { status: 400 }) };
  }
  const server = await getServerById(getDb(), serverId);
  if (!server) {
    return { ok: false, response: NextResponse.json({ error: 'Server not found' }, { status: 404 }) };
  }
  if (server.ownerUserId !== userId) {
    if (!(await isServerMember(getDb(), userId, serverId))) {
      return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
  }
  const role = await getRoleById(getDb(), roleId);
  if (!role || role.serverId !== serverId) {
    return { ok: false, response: NextResponse.json({ error: 'Role not found' }, { status: 404 }) };
  }
  return { ok: true, role };
}

async function loadRoleForWrite(serverId: string, roleId: string, userId: string): Promise<AuthContext | AuthError> {
  const ctx = await loadRoleForRead(serverId, roleId, userId);
  if (!ctx.ok) return ctx;
  const permissions = await getUserPermissions(getDb(), userId, serverId);
  if (!hasPermission(permissions, CorePermission.MANAGE_ROLES)) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return ctx;
}

async function handleGet(req: Request, ctx: { params: Promise<{ id: string; roleId: string }> }): Promise<NextResponse> {
  const { id: serverId, roleId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const access = await loadRoleForRead(serverId, roleId, session.uid);
    if (!access.ok) return access.response;
    return NextResponse.json(
      { role: toJson(access.role) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to load role' },
      { status: 500 }
    );
  }
}

async function handlePatch(req: Request, ctx: { params: Promise<{ id: string; roleId: string }> }): Promise<NextResponse> {
  const { id: serverId, roleId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const access = await loadRoleForWrite(serverId, roleId, session.uid);
    if (!access.ok) return access.response;

    let body: z.infer<typeof PatchRoleSchema>;
    try {
      const raw = await req.json();
      body = PatchRoleSchema.parse(raw);
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    if (
      body.name === undefined &&
      body.color === undefined &&
      body.icon === undefined &&
      body.displaySeparately === undefined &&
      body.position === undefined &&
      body.permissions === undefined
    ) {
      return NextResponse.json(
        { role: toJson(access.role) },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (body.name !== undefined && access.role.name === EVERYONE_ROLE_NAME && body.name !== EVERYONE_ROLE_NAME) {
      return NextResponse.json(
        { error: 'Cannot rename the @everyone role' },
        { status: 400 }
      );
    }

    if (body.permissions !== undefined) {
      const unknown = body.permissions.filter((p) => !KNOWN_PERMISSIONS.has(p));
      if (unknown.length > 0) {
        return NextResponse.json(
          { error: 'Unknown permissions in request', unknown },
          { status: 400 }
        );
      }
    }

    const updated = await updateRole(getDb(), roleId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.color !== undefined ? { color: body.color } : {}),
      ...(body.icon !== undefined ? { icon: body.icon } : {}),
      ...(body.displaySeparately !== undefined ? { displaySeparately: body.displaySeparately } : {}),
      ...(body.position !== undefined ? { position: body.position } : {}),
      ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
    });
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'role.update',
      targetType: 'role',
      targetId: roleId,
      metadata: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.icon !== undefined ? { icon: body.icon } : {}),
        ...(body.displaySeparately !== undefined ? { displaySeparately: body.displaySeparately } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
        ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
      },
    }).catch((err) => console.error('[audit] role.update failed:', (err as Error).message));
    return NextResponse.json(
      { role: toJson(updated) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to update role' },
      { status: 500 }
    );
  }
}

async function handleDelete(req: Request, ctx: { params: Promise<{ id: string; roleId: string }> }): Promise<NextResponse> {
  const { id: serverId, roleId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const access = await loadRoleForWrite(serverId, roleId, session.uid);
    if (!access.ok) return access.response;

    if (access.role.name === EVERYONE_ROLE_NAME) {
      return NextResponse.json(
        { error: 'Cannot delete the @everyone role' },
        { status: 400 }
      );
    }

    await deleteRole(getDb(), roleId);
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'role.delete',
      targetType: 'role',
      targetId: roleId,
    }).catch((err) => console.error('[audit] role.delete failed:', (err as Error).message));
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json(
      { error: 'Failed to delete role' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'roles-get-one', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const PATCH = withApiSecurity(handlePatch, {
  allowedMethods: ['PATCH'],
  rateLimit: { identifier: 'roles-patch', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const DELETE = withApiSecurity(handleDelete, {
  allowedMethods: ['DELETE'],
  rateLimit: { identifier: 'roles-delete', config: { windowMs: 60_000, maxRequests: 10 } },
});
