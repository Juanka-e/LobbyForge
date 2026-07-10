import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DEFAULT_USER_PRIVACY_SETTINGS, getServerById, getUserSettings, isServerMember } from '@lobbyforge/db';
import {
  requireChannelInServer,
  requireMaterializedSession,
  requireServerMember,
} from '@/lib/api-auth';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { getUserPresenceInServer, setUserPresence, incrServerBandwidth } from '@/lib/redis';
import { publishPresenceChange } from '@/lib/presence-bus';
import { getDb } from '@/lib/db';
import { applyPresencePrivacy } from '@/lib/presence-privacy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

const PresenceSchema = z.object({
  serverId: z.string().uuid(),
  channelId: z.string().uuid(),
  status: z.enum(['online', 'idle', 'dnd', 'offline']).default('online'),
  activity: z
    .object({
      kind: z.enum(['game', 'music', 'watch_party', 'custom']),
      label: z.string().min(1).max(128),
      pluginId: z.string().max(80).optional(),
      serverName: z.string().max(120).optional(),
    })
    .optional(),
  /**
   * Optional RTC stats delta since the last heartbeat (M21.5-bandwidth).
   * The lobby voice client samples LiveKit's `bytesSent`/`bytesReceived`
   * every ~30s and reports the difference here. The presence route
   * forwards it to `incrServerBandwidth` so every Next.js worker
   * contributes to the same Redis counters.
   */
  bandwidthDeltaBytes: z.number().nonnegative().max(10 * 1024 * 1024 * 1024).optional(),
});

async function handlePost(req: Request): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;
  const { session } = sessionResult;

  let body: z.infer<typeof PresenceSchema>;
  try {
    const raw = await req.json();
    body = PresenceSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const member = await requireServerMember(session.uid, body.serverId);
    if (!member.ok) return member.response;
    const channel = await requireChannelInServer(body.channelId, body.serverId);
    if (!channel.ok) return channel.response;
    await setUserPresence(session.uid, body.serverId, body.channelId, body.status, 90, body.activity);
    // Push the presence change to every WS subscriber on this server.
    publishPresenceChange({
      serverId: body.serverId,
      event: {
        type: 'presence-update',
        userId: session.uid,
        status: body.status,
        channelId: body.channelId,
        lastSeen: Date.now(),
        ...(body.activity ? { activity: body.activity } : {}),
      },
    });
    if (body.bandwidthDeltaBytes && body.bandwidthDeltaBytes > 0) {
      const threshold = process.env.LOBBYFORGE_BANDWIDTH_ALERT_BYTES
        ? Number(process.env.LOBBYFORGE_BANDWIDTH_ALERT_BYTES)
        : undefined;
      await incrServerBandwidth(body.serverId, body.bandwidthDeltaBytes, {
        alertThresholdBytes: threshold,
      }).catch(() => {
        // A Redis blip on the bandwidth counter is fine — the presence
        // write itself already succeeded, so the user is still visible
        // as in-voice. The next heartbeat will add to the counters.
      });
    }
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: 'Failed to update presence' },
      { status: 500 }
    );
  }
}

async function handleGet(req: Request): Promise<NextResponse> {
  const secret = getSessionSecret();
  const session = readGuestSession(req.headers.get('cookie'), secret);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  if (!session.uid) {
    return NextResponse.json(
      { error: 'Guest user has no materialized user record', howToFix: 'Re-issue POST /api/auth/guest' },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  if (!serverId) {
    return NextResponse.json({ error: 'serverId query parameter is required' }, { status: 400 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(serverId)) {
    return NextResponse.json({ error: 'Invalid serverId' }, { status: 400 });
  }

  try {
    const server = await getServerById(getDb(), serverId);
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    if (server.ownerUserId !== session.uid) {
      const member = await isServerMember(getDb(), session.uid, serverId);
      if (!member) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
    const presences = await getUserPresenceInServer(serverId);
    const filtered = await Promise.all(
      presences.map(async (presence) => {
        const settings = await getUserSettings(getDb(), presence.userId);
        return applyPresencePrivacy(presence, settings?.privacy ?? DEFAULT_USER_PRIVACY_SETTINGS, {
          isSelf: presence.userId === session.uid,
          isServerMember: true,
        });
      })
    );
    return NextResponse.json(
      { presences: filtered },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to fetch presence' },
      { status: 500 }
    );
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'presence-update', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'presence-list', config: { windowMs: 60_000, maxRequests: 60 } },
});
