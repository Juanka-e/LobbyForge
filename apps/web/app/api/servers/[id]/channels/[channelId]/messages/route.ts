import { NextResponse } from 'next/server';
import { z } from 'zod';
import { MessageContentSchema } from '@lobbyforge/core';
import {
  createMessage,
  getActiveMemberTimeout,
  getBlockedUserIds,
  listMessagesForChannel,
  logAction,
  type MessageRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import {
  CorePermission,
  authorizeChannelVisibility,
  authorizeServerPermission,
} from '@/lib/permissions';
import { authorizeChannelMessageAccess } from '@/lib/message-authorization';
import { publishChatMessage } from '@/lib/chat-bus';
import { moderateMessage, moderationBlockedBody } from '@/lib/bots/moderation';
import { messageBotJson } from '@/lib/bots/bot-i18n-server';
import { emitMessageEvent } from '@/lib/bots/events';
import { requireVerifiedEmail } from '@/lib/mail/verification';
import { readMessagePollId } from '@/lib/chat-polls';
import { loadPollViewsForMessages } from '@/lib/chat-polls-server';
import { MESSAGE_BODY_MAX_BYTES } from '@/lib/message-limits';
import { mentionsEveryoneOrHere } from '@/lib/everyone-mention';
import { MAX_MENTIONS } from '@/lib/mentions';
import { mentionEveryoneRefusal, resolveMessageMentions } from '@/lib/message-mentions-server';
import { notifyMentionedMembers } from '@/lib/mention-notify';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// security-review AUTHZ-008: a message's `metadata` is written by the
// server only — polls, bots, webhooks, apps, pins. A member's POST used to
// accept a free-form record (only its top-level key NAMES were checked),
// so about 1 MB could ride along on every message into each lobby render,
// list response and live subscriber. No first-party client sends it: it is
// refused outright (`metadata_not_allowed`), and the schema is strict, so
// any other unknown field is a 400 too instead of being dropped silently.
const CreateMessageSchema = z.object({
  content: MessageContentSchema,
  replyToId: z.string().uuid().optional(),
  // docs/PROFILES.md "Mentions": the members the composer's picker
  // inserted. Only a hint — the server keeps those that are members and
  // whose name is in the text, adds typed @handles, and stores the result
  // in `metadata.mentions` itself.
  mentions: z.array(z.string().uuid()).max(MAX_MENTIONS).optional(),
}).strict();

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

function toJson(message: MessageRow): Record<string, unknown> {
  return {
    id: message.id,
    channelId: message.channelId,
    userId: message.userId,
    // Bots milestone: a bot-authored message has userId null and names its bot
    // (`defaultName: true` when a built-in bot still has its default name).
    botId: message.botId ?? null,
    bot: messageBotJson(message),
    content: message.content,
    metadata: message.metadata,
    replyToId: message.replyToId,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
  };
}

async function resolveSession(req: Request): Promise<
  | { ok: true; uid: string }
  | { ok: false; response: NextResponse }
> {
  const secret = getSessionSecret();
  const session = readGuestSession(req.headers.get('cookie'), secret);
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }
  if (!session.uid) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Guest user has no materialized user record', howToFix: 'Re-issue POST /api/auth/guest' },
        { status: 503 }
      ),
    };
  }
  return { ok: true, uid: session.uid };
}

async function handleGet(
  req: Request,
  ctx: { params: Promise<{ id: string; channelId: string }> }
): Promise<NextResponse> {
  const { id: serverId, channelId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    // LF-SEC-002: the canonical policy (membership + visibility +
    // READ_MESSAGE_HISTORY) — the SAME helper the single-message route
    // uses, so neither side can drift weaker than the other.
    const access = await authorizeChannelMessageAccess({
      userId: session.uid,
      serverId,
      channelId,
      operation: 'read',
    });
    if (!access.ok) return access.response;

    // Optional `before` cursor for pagination: ISO-8601 timestamp.
    // The list query always orders newest-first, so "before" is a
    // "give me messages older than this" pagination.
    const url = new URL(req.url);
    const beforeParam = url.searchParams.get('before');
    const before = beforeParam ? new Date(beforeParam) : undefined;
    if (beforeParam && (!before || Number.isNaN(before.getTime()))) {
      return NextResponse.json({ error: 'Invalid `before` cursor' }, { status: 400 });
    }

    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.max(1, Math.min(100, Number.parseInt(limitParam, 10))) : 50;
    if (limitParam && (!Number.isFinite(limit) || String(limit) !== limitParam)) {
      return NextResponse.json({ error: 'Invalid `limit`' }, { status: 400 });
    }

    const rows = await listMessagesForChannel(getDb(), channelId, {
      limit,
      ...(before ? { before } : {}),
    });

    // Mask messages from blocked users. The caller's block list is
    // fetched once; each message from a blocked author gets its content
    // replaced with a placeholder so the blocked user's words never
    // reach the client. The message row stays so the conversation
    // flow makes sense.
    const blockedIds = await getBlockedUserIds(getDb(), session.uid);
    // Polls (docs/CHAT_POLLS.md): ONE query for the page, projected for
    // this viewer — counts only once visible to them, never a voter.
    const polls = await loadPollViewsForMessages(rows, session.uid);
    const messages = rows.map((m) => {
      const json = toJson(m);
      // `poll` is present on poll messages only (null when it is gone or hidden).
      const isPoll = readMessagePollId(m.metadata) !== null;
      if (m.userId && blockedIds.has(m.userId)) {
        return {
          ...json,
          blocked: true,
          content: '🚫 Blocked user — message hidden.',
          userId: null,
          ...(isPoll ? { poll: null } : {}),
        };
      }
      return { ...json, blocked: false, ...(isPoll ? { poll: polls.get(m.id) ?? null } : {}) };
    });

    return NextResponse.json(
      { messages },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to list messages' },
      { status: 500 }
    );
  }
}

async function handlePost(
  req: Request,
  ctx: { params: Promise<{ id: string; channelId: string }> }
): Promise<NextResponse> {
  const { id: serverId, channelId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;
  // docs/EMAIL.md §4.2: an unverified account in `required` mode may read, not do this.
  const unverified = await requireVerifiedEmail(session.uid, 'message');
  if (unverified) return unverified;

  try {
    // LF-SEC-002: canonical policy for sends — membership + channel
    // visibility + SEND_MESSAGES in one helper (owner has SEND_MESSAGES
    // via @admin; members via the @everyone default role).
    const access = await authorizeChannelMessageAccess({
      userId: session.uid,
      serverId,
      channelId,
      operation: 'send',
    });
    if (!access.ok) return access.response;

    let body: z.infer<typeof CreateMessageSchema>;
    try {
      const raw: unknown = await req.json();
      if (raw !== null && typeof raw === 'object' && 'metadata' in raw) {
        return NextResponse.json(
          { error: 'Message metadata is set by the server only', code: 'metadata_not_allowed' },
          { status: 400 }
        );
      }
      body = CreateMessageSchema.parse(raw);
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    // MODERATE_MEMBERS timeout: timed-out members cannot send messages
    // until the timeout expires (cleared with the same endpoint).
    const activeTimeout = await getActiveMemberTimeout(getDb(), serverId, session.uid);
    if (activeTimeout) {
      return NextResponse.json(
        { error: 'You are timed out in this server', code: 'timed_out', until: activeTimeout.toISOString() },
        { status: 403 }
      );
    }

    // MENTION_EVERYONE: @everyone or @here in the content requires the
    // explicit permission (notification-spam control, Discord semantics).
    if (mentionsEveryoneOrHere(body.content)) {
      const mentionAuth = await authorizeServerPermission(
        session.uid,
        serverId,
        CorePermission.MENTION_EVERYONE
      );
      if (!mentionAuth.ok) return mentionEveryoneRefusal(mentionAuth.response);
    }
    // Bots milestone: the server's Moderation Bot (if enabled) checks the
    // message before it is stored. A blocked sender gets a 422 whose
    // code + rule the lobby translates; the bot writes the audit entry.
    const moderation = await moderateMessage({
      serverId,
      channelId,
      userId: session.uid,
      content: body.content,
      ownerUserId: access.context.server.ownerUserId,
      kind: 'create',
    });
    if (moderation.action === 'block') {
      return NextResponse.json(moderationBlockedBody(moderation), {
        status: 422,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const mentions = await resolveMessageMentions(getDb(), serverId, body.content, body.mentions ?? []);
    const created = await createMessage(getDb(), {
      channelId,
      userId: session.uid,
      content: body.content,
      ...(mentions.length > 0 ? { metadata: { mentions } } : {}),
      ...(body.replyToId !== undefined ? { replyToId: body.replyToId } : {}),
    });
    publishChatMessage({
      serverId,
      channelId,
      message: {
        id: created.id,
        channelId: created.channelId,
        userId: created.userId ?? session.uid,
        content: created.content,
        metadata: created.metadata,
        replyToId: created.replyToId,
        createdAt: created.createdAt.toISOString(),
      },
    });
    // docs/PROFILES.md "Mentions": each member it names hears it on their
    // own feed (a badge on the channel, a desktop notification).
    if (mentions.length > 0) {
      notifyMentionedMembers({ serverId, channelId, messageId: created.id, authorId: session.uid, mentions });
    }
    // Bot API v2: bots' outgoing event endpoints (fire-and-forget, cached
    // per server — no query per bot).
    emitMessageEvent({
      serverId,
      channel: { id: access.context.channel.id, type: access.context.channel.type },
      event: 'message_create',
      message: {
        id: created.id,
        content: created.content,
        createdAt: created.createdAt.toISOString(),
        replyToId: created.replyToId,
        userId: session.uid,
      },
    });
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'message.create',
      targetType: 'message',
      targetId: created.id,
      metadata: { channelId, replyToId: body.replyToId ?? null },
    }).catch((err) => console.error('[audit] message.create failed:', (err as Error).message));
    return NextResponse.json(
      { message: toJson(created) },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to create message' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'messages-list', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: MESSAGE_BODY_MAX_BYTES,
  rateLimit: { identifier: 'messages-create', config: { windowMs: 60_000, maxRequests: 30 } },
});
