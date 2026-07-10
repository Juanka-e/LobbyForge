import { NextResponse } from 'next/server';
import {
  DEFAULT_USER_PRIVACY_SETTINGS,
  getChannelById,
  getServerById,
  getUserSettings,
  isServerMember,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { getUserPresenceInChannel } from '@/lib/redis';
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

async function handleGet(
  req: Request,
  ctx: { params: Promise<{ id: string; channelId: string }> }
): Promise<NextResponse> {
  const { id: serverId, channelId } = await ctx.params;

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

  if (!serverId || !channelId) {
    return NextResponse.json({ error: 'serverId and channelId are required' }, { status: 400 });
  }

  try {
    const server = await getServerById(getDb(), serverId);
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    const channel = await getChannelById(getDb(), channelId);
    if (!channel || channel.serverId !== serverId) {
      return NextResponse.json({ error: 'Channel not found in this server' }, { status: 404 });
    }
    if (server.ownerUserId !== session.uid) {
      const member = await isServerMember(getDb(), session.uid, serverId);
      if (!member) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
    const presences = await getUserPresenceInChannel(channelId);
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
      { error: 'Failed to fetch channel presence' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'channel-presence', config: { windowMs: 60_000, maxRequests: 60 } },
});
