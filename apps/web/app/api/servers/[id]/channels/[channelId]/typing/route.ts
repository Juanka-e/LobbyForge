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
import { authorizeChannelMessageAccess } from '@/lib/message-authorization';
import { refuseTimedOutActor } from '@/lib/actor-timeout';
import { resolveMemberDisplayName } from '@/lib/member-display-name';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/servers/{id}/channels/{channelId}/typing
 *   Records that the user is typing. TTL 5s in Redis. Only someone who may
 *   post here may say they are typing: the message route's send check
 *   (membership, channel visibility, SEND_MESSAGES), and not while timed
 *   out — 403 otherwise, and nothing is recorded. The name shown is the
 *   member's community nickname, else their account name, resolved here
 *   (security review 2026-10, A10: it was the session cookie's name, which
 *   ignored nicknames and went stale on a rename).
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
  const { uid } = session.session;

  try {
    const access = await authorizeChannelMessageAccess({ userId: uid, serverId, channelId, operation: 'send' });
    if (!access.ok) return access.response;
    const timedOut = await refuseTimedOutActor(serverId, uid, access.context.server.ownerUserId);
    if (timedOut) return timedOut;
    const displayName = await resolveMemberDisplayName(serverId, uid, session.session.name || 'User');
    await setTyping(serverId, channelId, uid, displayName);
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
