/**
 * POST /api/servers/{id}/channels/{channelId}/polls — post a poll in a text
 * or announcement channel (docs/CHAT_POLLS.md).
 *
 * The same gates as sending a message (email verification, channel access
 * with SEND_MESSAGES, member timeout, @everyone, the Moderation Bot over the
 * question and every option, the message rate limit) plus CREATE_POLLS.
 * The poll is stored with a message row whose content is the question —
 * what bots, search and notifications see — in one transaction, then
 * broadcast as a normal `message` event.
 */
import { NextResponse } from 'next/server';
import { createMessagePoll, getActiveMemberTimeout, logAction } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { CorePermission, authorizeServerPermission } from '@/lib/permissions';
import { authorizeChannelMessageAccess } from '@/lib/message-authorization';
import { publishChatMessage } from '@/lib/chat-bus';
import { moderateMessage, moderationBlockedBody } from '@/lib/bots/moderation';
import { emitMessageEvent } from '@/lib/bots/events';
import { requireVerifiedEmail } from '@/lib/mail/verification';
import { CreateChatPollSchema, isPollChannelType, projectChatPoll, type CreateChatPollBody } from '@/lib/chat-polls';
import { messageJson, resolvePollSession } from '@/lib/chat-polls-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HOUR_MS = 60 * 60 * 1000;

async function handlePost(
  req: Request,
  ctx: { params: Promise<{ id: string; channelId: string }> }
): Promise<NextResponse> {
  const { id: serverId, channelId } = await ctx.params;

  const session = resolvePollSession(req);
  if (!session.ok) return session.response;
  // docs/EMAIL.md §4.2: a poll is a post — an unverified account in `required` mode may read, not do this.
  const unverified = await requireVerifiedEmail(session.uid, 'message');
  if (unverified) return unverified;

  try {
    const access = await authorizeChannelMessageAccess({ userId: session.uid, serverId, channelId, operation: 'send' });
    if (!access.ok) return access.response;

    if (!isPollChannelType(access.context.channel.type)) {
      return NextResponse.json(
        { error: 'Polls can only be posted in text and announcement channels', code: 'poll_channel_type' },
        { status: 400 }
      );
    }

    const pollAuth = await authorizeServerPermission(session.uid, serverId, CorePermission.CREATE_POLLS);
    if (!pollAuth.ok) return pollAuth.response;

    let body: CreateChatPollBody;
    try {
      const parsed = CreateChatPollSchema.safeParse(await req.json());
      if (!parsed.success) {
        const duplicate = parsed.error.issues.some((issue) => issue.message === 'duplicate');
        return NextResponse.json(
          { error: 'Invalid poll', code: duplicate ? 'poll_duplicate_option' : 'invalid_poll' },
          { status: 400 }
        );
      }
      body = parsed.data;
    } catch {
      return NextResponse.json({ error: 'Invalid request body', code: 'invalid_poll' }, { status: 400 });
    }

    // MODERATE_MEMBERS timeout: the same gate as a message.
    const activeTimeout = await getActiveMemberTimeout(getDb(), serverId, session.uid);
    if (activeTimeout) {
      return NextResponse.json(
        { error: 'You are timed out in this server', until: activeTimeout.toISOString() },
        { status: 403 }
      );
    }

    // Everything a reader will see, as one text: the question and the options.
    const text = [body.question, ...body.options].join('\n');

    // MENTION_EVERYONE: @everyone anywhere in the poll needs the permission, as in a message.
    if (/(^|\s)@everyone\b/i.test(text)) {
      const mentionAuth = await authorizeServerPermission(session.uid, serverId, CorePermission.MENTION_EVERYONE);
      if (!mentionAuth.ok) return mentionAuth.response;
    }

    // The Moderation Bot judges the poll exactly like a new message.
    const moderation = await moderateMessage({
      serverId,
      channelId,
      userId: session.uid,
      content: text,
      ownerUserId: access.context.server.ownerUserId,
      kind: 'create',
    });
    if (moderation.action === 'block') {
      return NextResponse.json(moderationBlockedBody(moderation), {
        status: 422,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const now = new Date();
    const { message, poll } = await createMessagePoll(getDb(), {
      channelId,
      userId: session.uid,
      question: body.question,
      options: body.options,
      allowMultiple: body.allowMultiple,
      closesAt: new Date(now.getTime() + body.durationHours * HOUR_MS),
    });
    // Nobody has voted yet, so every viewer sees the same thing.
    const view = projectChatPoll(
      { ...poll, counts: poll.options.map(() => 0), totalVoters: 0, viewerChoices: [] },
      now
    );

    publishChatMessage({
      serverId,
      channelId,
      message: {
        id: message.id,
        channelId: message.channelId,
        userId: message.userId ?? session.uid,
        content: message.content,
        metadata: message.metadata,
        replyToId: message.replyToId,
        createdAt: message.createdAt.toISOString(),
        poll: view,
      },
    });
    // Bots see the poll as a plain message: its question.
    emitMessageEvent({
      serverId,
      channel: { id: access.context.channel.id, type: access.context.channel.type },
      event: 'message_create',
      message: {
        id: message.id,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
        replyToId: null,
        userId: session.uid,
      },
    });
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'poll.create',
      targetType: 'message',
      targetId: message.id,
      metadata: { channelId, pollId: poll.id, options: poll.options.length, allowMultiple: poll.allowMultiple },
    }).catch((err) => console.error('[audit] poll.create failed:', (err as Error).message));

    return NextResponse.json(
      { message: messageJson(message), poll: view },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ error: 'Failed to create poll' }, { status: 500 });
  }
}

// The same budget as POST .../messages — a poll is a message.
export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'messages-create', config: { windowMs: 60_000, maxRequests: 30 } },
});
