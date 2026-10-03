import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerById, isServerMember } from '@lobbyforge/db';
import {
  requireVisibleChannelInServer,
  requireMaterializedSession,
  requireServerMember,
} from '@/lib/api-auth';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { getUserPresenceInServer, setUserPresence, incrServerBandwidth, reserveUserBandwidth } from '@/lib/redis';
import { publishPresenceChange } from '@/lib/presence-bus';
import { getDb } from '@/lib/db';
import { projectServerPresenceForViewer } from '@/lib/presence-view';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

/*
 * Client-reported bandwidth is capped (security follow-up): the browser
 * decides `bandwidthDeltaBytes`, so without a bound one member could add
 * terabytes to a server's counters and trip the admin bandwidth alert.
 *
 * One report covers the time since the previous sample: the voice
 * heartbeat runs every 5 s (`HEARTBEAT_INTERVAL_MS` in
 * LobbyVoiceProvider), but a hidden tab's timers are throttled to about
 * once a minute, so a single report may honestly cover up to 60 s. The
 * ceiling on what one participant can send + receive is a generous
 * 32 Mbit/s (4 MB/s) — several 1080p streams plus a screen share; voice
 * alone is well under 0.1 Mbit/s. So:
 *
 *   per report:          4 MB/s × 60 s   = 240 MB  (larger values are clamped)
 *   per user, per hour:  4 MB/s × 3600 s = 14.4 GB (Redis, across all servers)
 */
const VOICE_HEARTBEAT_INTERVAL_MS = 5_000;
const HIDDEN_TAB_TIMER_INTERVAL_MS = 60_000;
const MAX_CLIENT_BYTES_PER_SECOND = 4_000_000; // 32 Mbit/s
const MAX_BANDWIDTH_BYTES_PER_REPORT =
  (MAX_CLIENT_BYTES_PER_SECOND * Math.max(VOICE_HEARTBEAT_INTERVAL_MS, HIDDEN_TAB_TIMER_INTERVAL_MS)) / 1000;
const MAX_BANDWIDTH_BYTES_PER_USER_HOUR = MAX_CLIENT_BYTES_PER_SECOND * 3600;

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
    }).strict()
    .optional(),
  /**
   * Optional RTC stats delta since the last heartbeat (M21.5-bandwidth).
   * The lobby voice client samples LiveKit's `bytesSent`/`bytesReceived`
   * on every voice heartbeat and reports the difference here. The route
   * clamps it (see the caps above) and forwards it to
   * `incrServerBandwidth` so every Next.js worker contributes to the
   * same Redis counters.
   */
  bandwidthDeltaBytes: z.number().nonnegative().max(10 * 1024 * 1024 * 1024).optional(),
}).strict();

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
    const channel = await requireVisibleChannelInServer(session.uid, body.channelId, body.serverId);
    if (!channel.ok) return channel.response;
    await setUserPresence(session.uid, body.serverId, body.channelId, body.status, 90, body.activity);
    // beta-review (S5): tell WS subscribers "presence changed — re-fetch".
    // The event carries NO snapshot (status/channel/activity/user id);
    // every viewer re-reads GET below, which applies privacy settings,
    // blocks and channel visibility for THAT viewer.
    publishPresenceChange({ serverId: body.serverId });
    if (body.bandwidthDeltaBytes && body.bandwidthDeltaBytes > 0) {
      const threshold = process.env.LOBBYFORGE_BANDWIDTH_ALERT_BYTES
        ? Number(process.env.LOBBYFORGE_BANDWIDTH_ALERT_BYTES)
        : undefined;
      const reported = Math.min(body.bandwidthDeltaBytes, MAX_BANDWIDTH_BYTES_PER_REPORT);
      await reserveUserBandwidth(session.uid, reported, MAX_BANDWIDTH_BYTES_PER_USER_HOUR)
        .then((granted) =>
          granted > 0
            ? incrServerBandwidth(body.serverId, granted, { alertThresholdBytes: threshold })
            : undefined
        )
        .catch(() => {
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
    // beta-review (F8 + privacy): one projection shared with the lobby page.
    const filtered = await projectServerPresenceForViewer({
      serverId,
      viewerUserId: session.uid,
      ownerUserId: server.ownerUserId ?? null,
      presences: await getUserPresenceInServer(serverId),
    });
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
