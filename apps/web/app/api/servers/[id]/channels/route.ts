import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ChannelNameSchema } from '@lobbyforge/core';
import {
  createChannel,
  getServerById,
  getUserPermissions,
  isServerMember,
  listChannelsForServer,
  listVisibleChannelsForMember,
  logAction,
  type ChannelRow,
  type ChannelType,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { CorePermission, authorizeServerPermission, hasPermission } from '@/lib/permissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CHANNEL_TYPES = ['text', 'voice', 'activity', 'announcement', 'stage'] as const;

const CreateChannelSchema = z.object({
  name: ChannelNameSchema,
  type: z.enum(CHANNEL_TYPES),
  topic: z.string().max(512).optional(),
  pluginId: z.string().max(64).optional(),
  position: z.number().int().min(0).optional(),
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

async function assertServerAndMembership(
  serverId: string,
  userId: string
): Promise<
  | { ok: true; server: NonNullable<Awaited<ReturnType<typeof getServerById>>> }
  | { ok: false; response: NextResponse }
> {
  if (!serverId || typeof serverId !== 'string') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Server id is required' }, { status: 400 }),
    };
  }

  const server = await getServerById(getDb(), serverId);
  if (!server) {
    return { ok: false, response: NextResponse.json({ error: 'Server not found' }, { status: 404 }) };
  }
  const member = await isServerMember(getDb(), userId, serverId);
  if (!member) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ok: true, server };
}

async function handleGet(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const access = await assertServerAndMembership(serverId, session.uid);
    if (!access.ok) return access.response;

    // Role-gated visibility (0028): plain members see only channels they
    // can access; the owner and MANAGE_CHANNELS (administrator
    // short-circuits it) see everything so private rooms stay manageable.
    const permissions = await getUserPermissions(getDb(), session.uid, serverId);
    const canManage =
      access.server.ownerUserId === session.uid ||
      hasPermission(permissions, CorePermission.MANAGE_CHANNELS);
    const channels = canManage
      ? await listChannelsForServer(getDb(), serverId, { limit: 200 })
      : await listVisibleChannelsForMember(getDb(), serverId, session.uid);
    return NextResponse.json(
      { channels: channels.map(toJson) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to list channels' },
      { status: 500 }
    );
  }
}

async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const access = await assertServerAndMembership(serverId, session.uid);
    if (!access.ok) return access.response;

    let body: z.infer<typeof CreateChannelSchema>;
    try {
      const raw = await req.json();
      body = CreateChannelSchema.parse(raw);
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    // Permission gate — creating a channel requires MANAGE_CHANNELS.
    // The owner has it via @admin (or implicitly via the server.ownerUserId
    // shortcut in getUserPermissions), so the owner can still create the
    // "general" channel that every other member reads.
    const auth = await authorizeServerPermission(session.uid, serverId, CorePermission.MANAGE_CHANNELS);
    if (!auth.ok) return auth.response;

    const created = await createChannel(getDb(), {
      serverId,
      name: body.name,
      type: body.type as ChannelType,
      topic: body.topic ?? null,
      pluginId: body.pluginId ?? null,
      ...(body.position !== undefined ? { position: body.position } : {}),
    });
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'channel.create',
      targetType: 'channel',
      targetId: created.id,
      metadata: { name: body.name, type: body.type },
    }).catch((err) => console.error('[audit] channel.create failed:', (err as Error).message));

    return NextResponse.json(
      { channel: toJson(created) },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to create channel' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'channels-list', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'channels-create', config: { windowMs: 60_000, maxRequests: 10 } },
});
