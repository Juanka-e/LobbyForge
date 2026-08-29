import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ChannelNameSchema } from '@lobbyforge/core';
import {
  deleteChannel,
  getChannelById,
  listRolesBriefForServer,
  setChannelRoleOverrides,
  getServerById,
  isServerMember,
  logAction,
  updateChannel,
  type ChannelRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { CorePermission, authorizeServerPermission } from '@/lib/permissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PatchChannelSchema = z.object({
  name: ChannelNameSchema.optional(),
  topic: z.string().max(512).nullable().optional(),
  position: z.number().int().min(0).optional(),
  /**
   * Role-gated visibility (0028): the ONLY roles that can see this
   * channel. [] clears every override (visible to all members again).
   * Roles are validated to belong to this server.
   */
  visibleToRoleIds: z.array(z.string().uuid()).max(64).optional(),
});

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

function toJson(channel: ChannelRow): Record<string, unknown> {
  return {
    id: channel.id,
    serverId: channel.serverId,
    name: channel.name,
    type: channel.type,
    position: channel.position,
    pluginId: channel.pluginId,
    topic: channel.topic,
    createdAt: channel.createdAt.toISOString(),
  };
}

interface RouteContext {
  params: Promise<{ id: string; channelId: string }>;
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

async function loadAndAuthorize(
  serverId: string,
  channelId: string,
  userId: string,
  requireOwner: boolean
): Promise<
  | { ok: true; channel: ChannelRow; isOwner: boolean }
  | { ok: false; response: NextResponse }
> {
  if (!serverId || !channelId) {
    return { ok: false, response: NextResponse.json({ error: 'Server id and channel id are required' }, { status: 400 }) };
  }

  const server = await getServerById(getDb(), serverId);
  if (!server) {
    return { ok: false, response: NextResponse.json({ error: 'Server not found' }, { status: 404 }) };
  }

  const isOwner = server.ownerUserId === userId;
  if (requireOwner && !isOwner) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  if (!isOwner) {
    // For non-owner reads, also require membership.
    const member = await isServerMember(getDb(), userId, serverId);
    if (!member) {
      return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
  }

  const channel = await getChannelById(getDb(), channelId);
  if (!channel) {
    return { ok: false, response: NextResponse.json({ error: 'Channel not found' }, { status: 404 }) };
  }
  if (channel.serverId !== serverId) {
    // The channel exists but doesn't belong to the URL's server — surface
    // 404 (not 403) so we don't leak that the channel exists at all.
    return { ok: false, response: NextResponse.json({ error: 'Channel not found' }, { status: 404 }) };
  }
  return { ok: true, channel, isOwner };
}

async function handleGet(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, channelId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const access = await loadAndAuthorize(serverId, channelId, session.uid, false);
    if (!access.ok) return access.response;
    return NextResponse.json(
      { channel: toJson(access.channel) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to load channel' },
      { status: 500 }
    );
  }
}

async function handlePatch(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, channelId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const access = await loadAndAuthorize(serverId, channelId, session.uid, true);
    if (!access.ok) return access.response;

    // The M11 "owner-only" check is now a real MANAGE_CHANNELS permission
    // check. The owner gets it implicitly via getUserPermissions' server
    // ownership shortcut, so a freshly created server still has its
    // "general" channel editable by the owner.
    const auth = await authorizeServerPermission(session.uid, serverId, CorePermission.MANAGE_CHANNELS);
    if (!auth.ok) return auth.response;

    let body: z.infer<typeof PatchChannelSchema>;
    try {
      const raw = await req.json();
      body = PatchChannelSchema.parse(raw);
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const updated = await updateChannel(getDb(), channelId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.topic !== undefined ? { topic: body.topic } : {}),
      ...(body.position !== undefined ? { position: body.position } : {}),
    });

    if (body.visibleToRoleIds !== undefined) {
      // Every referenced role must belong to this server — a foreign
      // role id would silently never match anyone.
      const serverRoles = await listRolesBriefForServer(getDb(), serverId);
      const known = new Set(serverRoles.map((r) => r.id));
      const unknown = body.visibleToRoleIds.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        return NextResponse.json(
          { error: 'visibleToRoleIds contains roles not in this server', unknown },
          { status: 400 }
        );
      }
      await setChannelRoleOverrides(getDb(), channelId, body.visibleToRoleIds);
    }

    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'channel.update',
      targetType: 'channel',
      targetId: channelId,
      metadata: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.topic !== undefined ? { topic: body.topic } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
        ...(body.visibleToRoleIds !== undefined
          ? { visibleToRoleIds: body.visibleToRoleIds }
          : {}),
      },
    }).catch((err) => console.error('[audit] channel.update failed:', (err as Error).message));
    return NextResponse.json(
      { channel: toJson(updated) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to update channel' },
      { status: 500 }
    );
  }
}

async function handleDelete(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, channelId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const access = await loadAndAuthorize(serverId, channelId, session.uid, true);
    if (!access.ok) return access.response;

    const auth = await authorizeServerPermission(session.uid, serverId, CorePermission.MANAGE_CHANNELS);
    if (!auth.ok) return auth.response;

    await deleteChannel(getDb(), channelId);
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'channel.delete',
      targetType: 'channel',
      targetId: channelId,
    }).catch((err) => console.error('[audit] channel.delete failed:', (err as Error).message));
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json(
      { error: 'Failed to delete channel' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'channels-get-one', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const PATCH = withApiSecurity(handlePatch, {
  allowedMethods: ['PATCH'],
  rateLimit: { identifier: 'channels-patch', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const DELETE = withApiSecurity(handleDelete, {
  allowedMethods: ['DELETE'],
  rateLimit: { identifier: 'channels-delete', config: { windowMs: 60_000, maxRequests: 10 } },
});
