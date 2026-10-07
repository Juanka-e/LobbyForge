import { NextResponse } from 'next/server';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  endGameSession,
  getGameSessionById,
  getServerById,
  getUserPermissions,
  isServerMember,
  logAction,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { authorizeSessionChannelVisibility } from '@/lib/permissions';
import { publishActivityStateChange } from '@/lib/activity-bus';
import { activityError } from '@/lib/activity-errors';
import { getVoiceRoomSnapshot, isInVoice, pluginRequiresVoice } from '@/lib/activity-voice';
import { hostViewJson, resolveActivityHost } from '@/lib/activity-host';
import { getPluginServer } from '@/lib/plugin-server-registry';

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
    // security-review PLUG-002: membership first, like GET/actions/SSE.
    // Without it a host who was kicked or banned could still end their
    // game: visibility passes for anyone on a channel without overrides,
    // and the host shortcut below skips the permission check.
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

    // SEC-002: the session's channel may be private (role-gated) —
    // membership alone is not enough; owner/manage_channels bypass.
    const visibility = await authorizeSessionChannelVisibility(session.uid, serverId, row, server.ownerUserId);
    if (!visibility.ok) return visibility.response;

    // The host can end its own session; so can anyone with START_ACTIVITY.
    // In a game played over voice, a host who left the voice room hands
    // over or abandons it (lib/activity-host.ts): any voice participant may
    // end an abandoned session, and a participant who just became host may
    // end it as host.
    let isHost = row.createdBy === session.uid;
    let abandoned = false;
    if (!isHost) {
      const permissions = await getUserPermissions(getDb(), session.uid, serverId);
      if (!hasPermission(permissions, CorePermission.START_ACTIVITY)) {
        const plugin = getPluginServer(row.pluginId);
        const voice = pluginRequiresVoice(plugin) ? await getVoiceRoomSnapshot(serverId, row.channelId) : null;
        const host =
          plugin && voice
            ? await resolveActivityHost({
                db: getDb(),
                row,
                plugin,
                voice,
                ownerUserId: server.ownerUserId ?? null,
                skipTransferWhenAbandoned: true,
              })
            : null;
        if (!host) return activityError(403, 'not_host', 'Forbidden');
        const callerInVoice = isInVoice(voice, session.uid);
        if (host.view.abandoned) {
          if (!callerInVoice) {
            return activityError(403, 'voice_required', 'Join the activity’s voice channel to end an abandoned activity.', {
              abandoned: true,
            });
          }
          abandoned = true;
        } else if (host.view.hostUserId === session.uid) {
          // Hosting just moved to the caller (the host had left the room).
          isHost = true;
        } else {
          return activityError(403, 'not_host', 'Forbidden', {
            host: hostViewJson(host.view),
          });
        }
      }
    }

    const ended = await endGameSession(getDb(), sessionId);
    if (ended) {
      publishActivityStateChange({
        serverId,
        sessionId,
        status: ended.status,
        // SEC-001: no canonical state on the bus — ended state is public
        // (scores only), but consistency says every publisher stays lean.
        publicSummary: ended.publicSummary,
      });
    }
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'activity.end',
      targetType: 'session',
      targetId: sessionId,
      metadata: { pluginId: row.pluginId, wasHost: isHost, ...(abandoned ? { reason: 'abandoned' } : {}) },
    }).catch((err) => console.error('[audit] activity.end failed:', (err as Error).message));
    return NextResponse.json(
      { activity: ended && { id: ended.id, status: ended.status, endedAt: ended.endedAt?.toISOString() ?? null } },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to end activity' },
      { status: 500 }
    );
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'activity-end', config: { windowMs: 60_000, maxRequests: 10 } },
});
