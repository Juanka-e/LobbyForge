/**
 * GET /api/servers/{id}/channels/{channelId}/polls/{pollId} — one poll as
 * the caller sees it (docs/CHAT_POLLS.md): counts once they have voted or
 * the poll has closed, the number of voters, and their own choices. Never
 * who chose what. The lobby refetches through here when a poll it shows
 * without counts closes.
 */
import { NextResponse } from 'next/server';
import { getBlockedUserIds } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { authorizeChannelMessageAccess } from '@/lib/message-authorization';
import { loadChannelPoll, loadPollForViewer, resolvePollSession } from '@/lib/chat-polls-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string; channelId: string; pollId: string }>;
}

async function handleGet(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, channelId, pollId } = await ctx.params;
  const session = resolvePollSession(req);
  if (!session.ok) return session.response;

  try {
    const access = await authorizeChannelMessageAccess({ userId: session.uid, serverId, channelId, operation: 'read' });
    if (!access.ok) return access.response;
    const found = await loadChannelPoll(pollId, channelId);
    if (!found.ok) return found.response;
    // A blocked author's poll is hidden like their messages.
    if (found.poll.creatorUserId && (await getBlockedUserIds(getDb(), session.uid)).has(found.poll.creatorUserId)) {
      return NextResponse.json({ error: 'Poll not found', code: 'poll_not_found' }, { status: 404 });
    }
    const loaded = await loadPollForViewer(pollId, session.uid);
    if (!loaded) return NextResponse.json({ error: 'Poll not found', code: 'poll_not_found' }, { status: 404 });
    return NextResponse.json({ poll: loaded.view }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Failed to load poll' }, { status: 500 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'poll-get', config: { windowMs: 60_000, maxRequests: 60 } },
});
