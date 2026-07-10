import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getGameSessionById,
  getServerById,
  getUserPermissions,
  isServerMember,
  listPlayersForSession,
  logAction,
  setGameSessionState,
} from '@lobbyforge/db';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { getPlugin } from '@/lib/plugin-registry';
import { buildHttpPluginContext, callHandleAction } from '@/lib/plugin-context';
import { withApiSecurity } from '@/lib/security-headers';
import { publishActivityStateChange } from '@/lib/activity-bus';
import { preparePluginAction } from '@/lib/prepare-plugin-action';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ActionSchema = z.object({
  type: z.string().min(1).max(64),
  // Action-specific fields are accepted but the host does not
  // validate them — the plugin's handleAction decides what's
  // meaningful for its own action union.
});

async function authorizePluginAction(input: {
  serverId: string;
  sessionId: string;
  actorUserId: string;
  hostUserId: string | null;
  plugin: NonNullable<ReturnType<typeof getPlugin>>;
  action: Record<string, unknown>;
}): Promise<{ ok: true; action: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  const actionType = String(input.action.type);
  const policy = input.plugin.actionPolicies?.[actionType] ?? { role: 'host' as const };

  if (policy.role === 'host' && input.hostUserId !== input.actorUserId) {
    const permissions = await getUserPermissions(getDb(), input.actorUserId, input.serverId);
    if (!hasPermission(permissions, CorePermission.START_ACTIVITY)) {
      return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
  }

  if (policy.role === 'player') {
    const players = await listPlayersForSession(getDb(), input.sessionId);
    if (!players.some((p) => p.userId === input.actorUserId)) {
      return { ok: false, response: NextResponse.json({ error: 'Player is not in this activity' }, { status: 403 }) };
    }
  }

  const normalizedAction = { ...input.action };
  for (const field of policy.actorFields ?? []) {
    normalizedAction[field] = input.actorUserId;
  }
  return { ok: true, action: normalizedAction };
}

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

async function handlePost(
  req: Request,
  ctx: { params: Promise<{ id: string; sessionId: string }> }
): Promise<NextResponse> {
  const { id: serverId, sessionId } = await ctx.params;
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

    const row = await getGameSessionById(getDb(), sessionId);
    if (!row) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 });
    }
    if (row.serverId !== serverId) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 });
    }

    const plugin = getPlugin(row.pluginId);
    if (!plugin) {
      // A session exists for a plugin we no longer ship. We can't
      // dispatch — surface a clear error so the UI can offer to end.
      return NextResponse.json(
        { error: 'Plugin not registered', pluginId: row.pluginId, howToFix: 'End the activity' },
        { status: 409 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }
    // The `type` field is required and must be a string. Other keys
    // are forwarded to the plugin as-is.
    const parseResult = ActionSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid action body' },
        { status: 400 }
      );
    }

    const actionAuth = await authorizePluginAction({
      serverId,
      sessionId,
      actorUserId: session.uid,
      hostUserId: row.createdBy,
      plugin,
      action: body,
    });
    if (!actionAuth.ok) return actionAuth.response;

    const prepared = await preparePluginAction(getDb(), {
      pluginId: row.pluginId,
      serverId,
      action: actionAuth.action,
    });
    if (!prepared.ok) {
      return NextResponse.json({ error: prepared.error }, { status: prepared.status });
    }

    const ctx2 = await buildHttpPluginContext({
      db: getDb(),
      sessionId,
      actorUserId: session.uid,
    });
    // State versioning: upgrade the persisted row to the plugin's
    // current shape before running the reducer. The reducer only
    // accepts the current shape, so without this step a session
    // written by an older build would crash on the first action.
    const migratedState = plugin.migrateState
      ? (plugin.migrateState(row.state) as Record<string, unknown>)
      : row.state;
    const nextState = callHandleAction(plugin, ctx2, migratedState, prepared.action) as Record<string, unknown>;
    await setGameSessionState(getDb(), sessionId, nextState);
    // Push the new state to any open SSE subscriptions on this session.
    // Fire-and-forget — a Redis blip must not fail the action.
    publishActivityStateChange({
      serverId,
      sessionId,
      status: row.status,
      state: nextState,
    });
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'activity.action',
      targetType: 'session',
      targetId: sessionId,
      metadata: { pluginId: row.pluginId, actionType: parseResult.data.type },
    }).catch((err) => console.error('[audit] activity.action failed:', (err as Error).message));
    return NextResponse.json(
      { activity: { id: row.id, state: nextState, status: row.status } },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to perform action' },
      { status: 500 }
    );
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'activity-action', config: { windowMs: 60_000, maxRequests: 30 } },
});
