/**
 * POST /api/servers/{id}/channels/{channelId}/polls/{pollId}/close — close a
 * poll before its time (docs/CHAT_POLLS.md). The poll's creator, or anyone
 * with MANAGE_MESSAGES (the owner and administrators included). A poll that
 * has already closed answers 409. The final results stay in the channel,
 * visible to everyone; a `poll_update` tells every open lobby.
 */
import { NextResponse } from 'next/server';
import { closeMessagePoll, getUserPermissions, logAction } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { CorePermission, hasPermission } from '@/lib/permissions';
import { authorizeChannelMessageAccess } from '@/lib/message-authorization';
import { publishChatPollUpdate } from '@/lib/chat-bus';
import { loadChannelPoll, loadPollForViewer, resolvePollSession } from '@/lib/chat-polls-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string; channelId: string; pollId: string }>;
}

async function handlePost(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, channelId, pollId } = await ctx.params;
  const session = resolvePollSession(req);
  if (!session.ok) return session.response;

  try {
    // Visibility only: who may close is decided below (creator or MANAGE_MESSAGES).
    const access = await authorizeChannelMessageAccess({ userId: session.uid, serverId, channelId, operation: 'mutate' });
    if (!access.ok) return access.response;
    const found = await loadChannelPoll(pollId, channelId);
    if (!found.ok) return found.response;

    const isCreator = found.poll.creatorUserId === session.uid;
    if (!isCreator) {
      const permissions = await getUserPermissions(getDb(), session.uid, serverId);
      if (!hasPermission(permissions, CorePermission.MANAGE_MESSAGES)) {
        return NextResponse.json({ error: 'Forbidden', code: 'poll_close_forbidden' }, { status: 403 });
      }
    }

    const result = await closeMessagePoll(getDb(), { pollId, userId: session.uid });
    if (!result.ok) {
      return result.reason === 'closed'
        ? NextResponse.json({ error: 'This poll is closed', code: 'poll_closed' }, { status: 409 })
        : NextResponse.json({ error: 'Poll not found', code: 'poll_not_found' }, { status: 404 });
    }

    const loaded = await loadPollForViewer(pollId, session.uid);
    if (!loaded) return NextResponse.json({ error: 'Poll not found', code: 'poll_not_found' }, { status: 404 });
    publishChatPollUpdate({ serverId, channelId, poll: loaded.update });
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'poll.close',
      targetType: 'message',
      targetId: found.poll.messageId,
      metadata: { channelId, pollId, byCreator: isCreator },
    }).catch((err) => console.error('[audit] poll.close failed:', (err as Error).message));
    return NextResponse.json({ poll: loaded.view }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Failed to close poll' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'poll-close', config: { windowMs: 60_000, maxRequests: 10 } },
});
