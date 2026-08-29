import { NextResponse } from 'next/server';
import { requireMaterializedSession } from '@/lib/api-auth';
import { requireVisibleChannelInServer } from '@/lib/api-auth';
import { getTypingUsers, setTyping } from '@/lib/redis';
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
 *   Returns { typers: string[] } — display names of users currently typing.
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
    const typers = await getTypingUsers(serverId, channelId, session.session.uid);
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
