/**
 * PUT    /api/servers/{id}/channels/{channelId}/polls/{pollId}/vote  { choices: number[] }
 * DELETE /api/servers/{id}/channels/{channelId}/polls/{pollId}/vote
 *
 * Cast, change or remove the caller's vote (docs/CHAT_POLLS.md). Anyone who
 * can read the channel may vote; a timed-out member and an unverified
 * account in `required` mode may not (a vote is a write, like a reaction).
 * A closed poll — expired or closed early — answers 409.
 *
 * The answer is the poll as the caller now sees it; every other viewer gets
 * a `poll_update` with the public counts. Neither ever names a voter.
 */
import { NextResponse } from 'next/server';
import { clearMessagePollVote, getActiveMemberTimeout, setMessagePollVote, type MessagePollRow } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { authorizeChannelMessageAccess } from '@/lib/message-authorization';
import { publishChatPollUpdate } from '@/lib/chat-bus';
import { requireVerifiedEmail } from '@/lib/mail/verification';
import { ChatPollVoteSchema, checkVoteChoices, isChatPollClosed } from '@/lib/chat-polls';
import { loadChannelPoll, loadPollForViewer, resolvePollSession } from '@/lib/chat-polls-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string; channelId: string; pollId: string }>;
}

const closedResponse = () =>
  NextResponse.json({ error: 'This poll is closed', code: 'poll_closed' }, { status: 409, headers: { 'Cache-Control': 'no-store' } });

/** Session, gates, channel read access and the poll — shared by PUT and DELETE. */
async function prepare(
  req: Request,
  ctx: RouteContext
): Promise<{ ok: true; uid: string; serverId: string; channelId: string; poll: MessagePollRow } | { ok: false; response: NextResponse }> {
  const { id: serverId, channelId, pollId } = await ctx.params;
  const session = resolvePollSession(req);
  if (!session.ok) return session;
  const unverified = await requireVerifiedEmail(session.uid, 'reaction');
  if (unverified) return { ok: false, response: unverified };

  const access = await authorizeChannelMessageAccess({ userId: session.uid, serverId, channelId, operation: 'read' });
  if (!access.ok) return access;
  const found = await loadChannelPoll(pollId, channelId);
  if (!found.ok) return found;

  const activeTimeout = await getActiveMemberTimeout(getDb(), serverId, session.uid);
  if (activeTimeout) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'You are timed out in this server', until: activeTimeout.toISOString() }, { status: 403 }),
    };
  }
  return { ok: true, uid: session.uid, serverId, channelId, poll: found.poll };
}

async function respondWithPoll(input: { uid: string; serverId: string; channelId: string; pollId: string }): Promise<NextResponse> {
  const loaded = await loadPollForViewer(input.pollId, input.uid);
  if (!loaded) return NextResponse.json({ error: 'Poll not found', code: 'poll_not_found' }, { status: 404 });
  publishChatPollUpdate({ serverId: input.serverId, channelId: input.channelId, poll: loaded.update });
  return NextResponse.json({ poll: loaded.view }, { headers: { 'Cache-Control': 'no-store' } });
}

async function handlePut(req: Request, ctx: RouteContext): Promise<NextResponse> {
  try {
    const ready = await prepare(req, ctx);
    if (!ready.ok) return ready.response;
    const { poll } = ready;

    let choices: number[];
    try {
      const parsed = ChatPollVoteSchema.safeParse(await req.json());
      if (!parsed.success) return NextResponse.json({ error: 'Invalid vote', code: 'invalid_vote' }, { status: 400 });
      choices = parsed.data.choices;
    } catch {
      return NextResponse.json({ error: 'Invalid request body', code: 'invalid_vote' }, { status: 400 });
    }
    const problem = checkVoteChoices(choices, { optionCount: poll.options.length, allowMultiple: poll.allowMultiple });
    if (problem) {
      return NextResponse.json(
        { error: problem === 'single_choice' ? 'This poll takes one answer' : 'Invalid vote', code: `vote_${problem}` },
        { status: 400 }
      );
    }

    const now = new Date();
    if (isChatPollClosed(poll, now)) return closedResponse();
    const result = await setMessagePollVote(getDb(), { pollId: poll.id, userId: ready.uid, optionIndexes: choices, now });
    if (!result.ok) {
      return result.reason === 'closed'
        ? closedResponse()
        : NextResponse.json({ error: 'Poll not found', code: 'poll_not_found' }, { status: 404 });
    }
    return respondWithPoll({ uid: ready.uid, serverId: ready.serverId, channelId: ready.channelId, pollId: poll.id });
  } catch {
    return NextResponse.json({ error: 'Failed to record vote' }, { status: 500 });
  }
}

async function handleDelete(req: Request, ctx: RouteContext): Promise<NextResponse> {
  try {
    const ready = await prepare(req, ctx);
    if (!ready.ok) return ready.response;
    const now = new Date();
    if (isChatPollClosed(ready.poll, now)) return closedResponse();
    const result = await clearMessagePollVote(getDb(), { pollId: ready.poll.id, userId: ready.uid, now });
    if (!result.ok) {
      return result.reason === 'closed'
        ? closedResponse()
        : NextResponse.json({ error: 'Poll not found', code: 'poll_not_found' }, { status: 404 });
    }
    return respondWithPoll({ uid: ready.uid, serverId: ready.serverId, channelId: ready.channelId, pollId: ready.poll.id });
  } catch {
    return NextResponse.json({ error: 'Failed to remove vote' }, { status: 500 });
  }
}

const rateLimit = { identifier: 'poll-vote', config: { windowMs: 60_000, maxRequests: 60 } };

export const PUT = withApiSecurity(handlePut, { allowedMethods: ['PUT'], rateLimit });
export const DELETE = withApiSecurity(handleDelete, { allowedMethods: ['DELETE'], rateLimit });
