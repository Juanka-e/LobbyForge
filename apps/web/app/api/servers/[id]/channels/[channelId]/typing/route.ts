import { NextResponse } from 'next/server';
import {
  DEFAULT_USER_PRIVACY_SETTINGS,
  getBlockedUserIds,
  getBlockersAmong,
  getUserSettings,
} from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { requireVisibleChannelInServer } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { canViewOnlineStatus } from '@/lib/presence-privacy';
import { getTypingEntries, setTyping } from '@/lib/redis';
import { withApiSecurity } from '@/lib/security-headers';
import { readGuestSession } from '@/lib/guest-session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('LOBBYFORGE_SESSION_SECRET must be set');
  return secret;
}

/**
 * POST /api/servers/{id}/channels/{channelId}/typing
 *   Records that the user is typing. TTL 5s in Redis.
 *
 * GET /api/servers/{id}/channels/{channelId}/typing
 *   Returns { typers: string[] } — display names of users currently typing,
 *   as this viewer may see them (below).
 */

async function handlePost(
  req: Request,
  ctx: { params: Promise<{ id: string; channelId: string }> }
): Promise<NextResponse> {
  const { id: serverId, channelId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  try {
    const channel = await requireVisibleChannelInServer(session.session.uid, channelId, serverId);
    if (!channel.ok) return channel.response;
    const secret = getSessionSecret();
    const guest = readGuestSession(req.headers.get('cookie'), secret);
    const displayName = guest?.name ?? 'User';
    await setTyping(serverId, channelId, session.session.uid, displayName);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

/**
 * The typers this viewer may see. Typing says "online, right now, here",
 * so the security review's rule for it is the presence rule: leave out
 * anyone the viewer blocked or who blocked the viewer (like the presence
 * view and the members list), and anyone whose online-status privacy hides
 * them from the viewer (lib/presence-privacy.ts — the channel presence
 * route drops `hidden` users the same way). Both users are members here:
 * the channel is visible to the viewer and the typer posted to it.
 */
async function visibleTypers(
  viewerUserId: string,
  entries: Array<{ userId: string; displayName: string }>
): Promise<string[]> {
  const others = entries.filter((entry) => entry.userId !== viewerUserId);
  // Polled every 3 s by every open channel: no query when nobody types.
  if (others.length === 0) return [];
  const db = getDb();
  const [blocked, blockers] = await Promise.all([
    getBlockedUserIds(db, viewerUserId),
    getBlockersAmong(db, viewerUserId, others.map((entry) => entry.userId)),
  ]);
  const candidates = others.filter((entry) => !blocked.has(entry.userId) && !blockers.has(entry.userId));
  const settings = await Promise.all(candidates.map((entry) => getUserSettings(db, entry.userId)));
  const names = candidates
    .filter((_entry, index) =>
      canViewOnlineStatus(settings[index]?.privacy ?? DEFAULT_USER_PRIVACY_SETTINGS, { isSelf: false, isServerMember: true })
    )
    .map((entry) => entry.displayName);
  return [...new Set(names)];
}

async function handleGet(
  req: Request,
  ctx: { params: Promise<{ id: string; channelId: string }> }
): Promise<NextResponse> {
  const { id: serverId, channelId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  try {
    const channel = await requireVisibleChannelInServer(session.session.uid, channelId, serverId);
    if (!channel.ok) return channel.response;
    const typers = await visibleTypers(session.session.uid, await getTypingEntries(serverId, channelId));
    return NextResponse.json({ typers }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ typers: [] });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'typing-post', config: { windowMs: 10_000, maxRequests: 30 } },
});

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'typing-get', config: { windowMs: 10_000, maxRequests: 30 } },
});
