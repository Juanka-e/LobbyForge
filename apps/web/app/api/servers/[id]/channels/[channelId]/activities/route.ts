import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  createGameSession,
  getActiveGameSessionForChannel,
  getChannelById,
  getPluginInstall,
  getServerById,
  getUserPermissions,
  isServerMember,
  listGameSessionsForChannel,
  logAction,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { getPlugin } from '@/lib/plugin-registry';
import { callCreateInitialState, buildHttpPluginContext } from '@/lib/plugin-context';
import { withApiSecurity } from '@/lib/security-headers';
import { requireChannelInServer } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const StartActivitySchema = z.object({
  pluginId: z.string().min(1).max(64),
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

function toSummary(row: Awaited<ReturnType<typeof listGameSessionsForChannel>>[number]) {
  return {
    id: row.id,
    serverId: row.serverId,
    channelId: row.channelId,
    pluginId: row.pluginId,
    status: row.status,
    publicSummary: row.publicSummary,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
  };
}

async function handleGet(
  req: Request,
  ctx: { params: Promise<{ id: string; channelId: string }> }
): Promise<NextResponse> {
  const { id: serverId, channelId } = await ctx.params;
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
    // CRITICAL: verify the channel belongs to the URL's server before
    // listing activities. Without this check, a member of Server A can
    // read activity data from any channel on Server B by guessing the
    // channelId.
    const channel = await getChannelById(getDb(), channelId);
    if (!channel || channel.serverId !== serverId) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }
    const sessions = await listGameSessionsForChannel(getDb(), channelId);
    return NextResponse.json(
      { activities: sessions.map(toSummary) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to list activities' },
      { status: 500 }
    );
  }
}

async function handlePost(
  req: Request,
  ctx: { params: Promise<{ id: string; channelId: string }> }
): Promise<NextResponse> {
  const { id: serverId, channelId } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const server = await getServerById(getDb(), serverId);
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    const permissions = await getUserPermissions(getDb(), session.uid, serverId);
    if (!hasPermission(permissions, CorePermission.START_ACTIVITY)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const channel = await requireChannelInServer(channelId, serverId);
    if (!channel.ok) return channel.response;
    if (channel.channel.type !== 'voice' && channel.channel.type !== 'stage') {
      return NextResponse.json({ error: 'Activities can only start in voice or stage channels' }, { status: 400 });
    }
    const active = await getActiveGameSessionForChannel(getDb(), channelId);
    if (active) {
      return NextResponse.json(
        { error: 'Channel already has an active activity', activity: toSummary(active) },
        { status: 409 }
      );
    }

    let body: z.infer<typeof StartActivitySchema>;
    try {
      const raw = await req.json();
      body = StartActivitySchema.parse(raw);
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const plugin = getPlugin(body.pluginId);
    if (!plugin) {
      return NextResponse.json({ error: 'Unknown plugin' }, { status: 404 });
    }
    const install = await getPluginInstall(getDb(), serverId, plugin.manifest.id);
    if (!install || !install.enabled) {
      return NextResponse.json(
        { error: 'App is not installed or enabled for this server' },
        { status: 403 }
      );
    }

    // Build the initial state against a fresh HTTP context. The
    // context's `state.save` is a no-op — the host persists the
    // returned state directly into the new row.
    const ctx = await buildHttpPluginContext({
      db: getDb(),
      sessionId: 'pending',
      actorUserId: session.uid,
    });
    const initialState = callCreateInitialState(plugin, ctx) as Record<string, unknown>;

    const created = await createGameSession(getDb(), {
      serverId,
      channelId,
      pluginId: plugin.manifest.id,
      createdBy: session.uid,
      state: initialState,
    });
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'activity.create',
      targetType: 'session',
      targetId: created.id,
      metadata: { pluginId: plugin.manifest.id, channelId },
    }).catch((err) => console.error('[audit] activity.create failed:', (err as Error).message));
    return NextResponse.json(
      { activity: toSummary(created) },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to start activity' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'activities-list', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'activities-create', config: { windowMs: 60_000, maxRequests: 10 } },
});
