import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CorePermission, hasPermission, MessageContentSchema } from '@lobbyforge/core';
import {
  deleteMessagePollForMessage,
  getActiveMemberTimeout,
  getBlockedUserIds,
  getMessageById,
  getUserPermissions,
  logAction,
  softDeleteMessage,
  updateMessage,
  type MessageRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { authorizeChannelMessageAccess } from '@/lib/message-authorization';
import { authorizeServerPermission } from '@/lib/permissions';
import { moderateMessage, moderationBlockedBody } from '@/lib/bots/moderation';
import { readMessageBot } from '@/lib/bots/message-meta';
import { emitMessageEvent } from '@/lib/bots/events';
import { publishChatMessageDelete, publishChatMessageUpdate } from '@/lib/chat-bus';
import { requireVerifiedEmail } from '@/lib/mail/verification';
import { readMessagePollId } from '@/lib/chat-polls';
import { loadPollViewsForMessages } from '@/lib/chat-polls-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PatchMessageSchema = z.object({
  content: MessageContentSchema.optional(),
  pinned: z.boolean().optional(),
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
    botId: message.botId ?? null,
    bot: readMessageBot(message),
    content: message.content,
    metadata: message.metadata,
    replyToId: message.replyToId,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
  };
}

interface RouteContext {
  params: Promise<{ id: string; channelId: string; messageId: string }>;
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

interface AuthorizeResult {
  ok: true;
  message: MessageRow;
  isOwner: boolean;
  isAuthor: boolean;
}
type AuthorizeError = { ok: false; response: NextResponse };

/**
 * LF-SEC-002: authorization for message-level routes now goes through
 * the CANONICAL channel policy (the same one the list route uses) —
 * membership + role-gated channel visibility (+ READ_MESSAGE_HISTORY
 * for reads). The old local check only verified membership and row
 * relationships, so a user whose private-channel role or history
 * permission was removed could still fetch any message by known ID.
 * Mutation additionally requires author-or-MANAGE_MESSAGES below.
 */
async function loadAndAuthorize(
  serverId: string,
  channelId: string,
  messageId: string,
  userId: string,
  operation: 'read' | 'mutate'
): Promise<AuthorizeResult | AuthorizeError> {
  if (!serverId || !channelId || !messageId) {
    return { ok: false, response: NextResponse.json({ error: 'Server, channel, and message ids are required' }, { status: 400 }) };
  }

  const access = await authorizeChannelMessageAccess({
    userId,
    serverId,
    channelId,
    operation,
  });
  if (!access.ok) return access;

  const message = await getMessageById(getDb(), messageId);
  if (!message || message.channelId !== channelId) {
    return { ok: false, response: NextResponse.json({ error: 'Message not found' }, { status: 404 }) };
  }

  return {
    ok: true,
    message,
    isOwner: access.context.server.ownerUserId === userId,
    isAuthor: message.userId === userId,
  };
}

/**
 * Mutation gate for DELETE. The caller may proceed if they are the
 * author OR if they have MANAGE_MESSAGES on the server. Content edits do
 * NOT use it — they are author-only (security-review AUTHZ-003); pinning
 * has its own owner/MANAGE_MESSAGES check in PATCH.
 */
async function canMutateMessage(
  serverId: string,
  isAuthor: boolean,
  userId: string
): Promise<boolean> {
  if (isAuthor) return true;
  const permissions = await getUserPermissions(getDb(), userId, serverId);
  return hasPermission(permissions, CorePermission.MANAGE_MESSAGES);
}

async function handleGet(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, channelId, messageId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const access = await loadAndAuthorize(serverId, channelId, messageId, session.uid, 'read');
    if (!access.ok) return access.response;
    // A poll message carries its poll as this viewer sees it (the lobby
    // refetches an edited message through here). A blocked author's poll
    // stays out, like their words in the list.
    const json = toJson(access.message);
    if (readMessagePollId(access.message.metadata)) {
      const blocked = access.message.userId
        ? (await getBlockedUserIds(getDb(), session.uid)).has(access.message.userId)
        : false;
      json.poll = blocked
        ? null
        : ((await loadPollViewsForMessages([access.message], session.uid)).get(access.message.id) ?? null);
    }
    return NextResponse.json(
      { message: json },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to load message' },
      { status: 500 }
    );
  }
}

async function handlePatch(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, channelId, messageId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const access = await loadAndAuthorize(serverId, channelId, messageId, session.uid, 'mutate');
    if (!access.ok) return access.response;

    let body: z.infer<typeof PatchMessageSchema>;
    try {
      const raw = await req.json();
      body = PatchMessageSchema.parse(raw);
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    if (body.content === undefined && body.pinned === undefined) {
      // Nothing to update — return the current row with 200.
      return NextResponse.json(
        { message: toJson(access.message) },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // beta-review: MODERATE_MEMBERS timeout applies to edits too — the
    // same gate the message POST route uses (a timed-out member could
    // still rewrite their existing messages, i.e. keep "posting").
    const activeTimeout = await getActiveMemberTimeout(getDb(), serverId, session.uid);
    if (activeTimeout) {
      return NextResponse.json(
        { error: 'You are timed out in this server', until: activeTimeout.toISOString() },
        { status: 403 }
      );
    }

    if (body.content !== undefined) {
      // docs/EMAIL.md §4.2: an unverified account in `required` mode may read, not do this.
      const unverified = await requireVerifiedEmail(session.uid, 'message');
      if (unverified) return unverified;
    }

    // A bot's (or the system's) words are not anyone's to rewrite: an edited
    // Welcome Bot message would still carry the BOT badge and its trust
    // level. Moderators may delete or pin it, never change its text.
    if (body.content !== undefined && (access.message.botId || !access.message.userId)) {
      return NextResponse.json({ error: 'Bot messages cannot be edited', code: 'bot_message_readonly' }, { status: 403 });
    }
    // Polls (docs/CHAT_POLLS.md): the question is the message's content and
    // people have voted on it — it does not change afterwards. Pinning stays.
    if (body.content !== undefined && readMessagePollId(access.message.metadata)) {
      return NextResponse.json({ error: 'Poll messages cannot be edited', code: 'poll_message_readonly' }, { status: 403 });
    }
    if (body.content !== undefined) {
      // security-review AUTHZ-003: only the AUTHOR may change a message's
      // text. MANAGE_MESSAGES (and the owner) used to pass here, so a
      // moderator could put words in anyone's mouth — the message still
      // shows the original author, with only an "edited" mark. Moderators
      // keep delete and pin.
      if (!access.isAuthor) {
        return NextResponse.json(
          { error: 'Only the author can edit this message', code: 'not_message_author' },
          { status: 403 }
        );
      }
      // An edit is a form of sending: an author whose SEND_MESSAGES was
      // revoked must not keep rewriting their old messages (the timeout
      // gate above covers MODERATE_MEMBERS timeouts).
      const sendAuth = await authorizeServerPermission(session.uid, serverId, CorePermission.SEND_MESSAGES);
      if (!sendAuth.ok) return sendAuth.response;
    }
    // Bots milestone: an edit cannot slip past the Moderation Bot — its
    // content rules run on the new text (the counting rules only count
    // new messages).
    if (body.content !== undefined) {
      const moderation = await moderateMessage({
        serverId,
        channelId,
        userId: session.uid,
        content: body.content,
        ownerUserId: access.isOwner ? session.uid : null,
        kind: 'edit',
      });
      if (moderation.action === 'block') {
        return NextResponse.json(moderationBlockedBody(moderation), {
          status: 422,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
    }
    if (body.pinned !== undefined) {
      const permissions = await getUserPermissions(getDb(), session.uid, serverId);
      if (!access.isOwner && !hasPermission(permissions, CorePermission.MANAGE_MESSAGES)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const metadata = { ...access.message.metadata };
    if (body.pinned === true) {
      metadata.$pinnedAt = new Date().toISOString();
      metadata.$pinnedBy = session.uid;
    } else if (body.pinned === false) {
      delete metadata.$pinnedAt;
      delete metadata.$pinnedBy;
    }

    const updated = await updateMessage(getDb(), messageId, {
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.pinned !== undefined ? { metadata } : {}),
    });
    if (body.content !== undefined) {
      // Bot API v2: bots hear about edits — the event stream through the
      // chat topic (the gateway reloads the message and checks access),
      // outgoing endpoints through the cached fan-out. Fire-and-forget.
      publishChatMessageUpdate({ serverId, channelId, messageId: updated.id, botId: updated.botId });
      emitMessageEvent({
        serverId,
        channel: { id: channelId },
        event: 'message_update',
        message: {
          id: updated.id,
          content: updated.content,
          createdAt: updated.createdAt.toISOString(),
          editedAt: updated.editedAt?.toISOString() ?? null,
          replyToId: updated.replyToId,
          userId: updated.userId,
        },
      });
    }
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: body.pinned === undefined ? 'message.update' : body.pinned ? 'message.pin' : 'message.unpin',
      targetType: 'message',
      targetId: messageId,
      metadata: { channelId },
    }).catch((err) => console.error('[audit] message.update failed:', (err as Error).message));
    return NextResponse.json(
      { message: toJson(updated) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to update message' },
      { status: 500 }
    );
  }
}

async function handleDelete(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: serverId, channelId, messageId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const access = await loadAndAuthorize(serverId, channelId, messageId, session.uid, 'mutate');
    if (!access.ok) return access.response;

    if (!(await canMutateMessage(serverId, access.isAuthor, session.uid))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await softDeleteMessage(getDb(), messageId);
    // A deleted poll message takes its poll and every ballot with it — the
    // soft delete never reaches the FK cascade.
    if (readMessagePollId(access.message.metadata)) {
      await deleteMessagePollForMessage(getDb(), messageId).catch((err) =>
        console.error('[polls] poll delete failed:', (err as Error).message)
      );
    }
    publishChatMessageDelete({ serverId, channelId, messageId, botId: access.message.botId });
    emitMessageEvent({
      serverId,
      channel: { id: channelId },
      event: 'message_delete',
      message: { id: messageId, ...(access.message.botId ? { bot: { id: access.message.botId, name: '' } } : {}) },
    });
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'message.delete',
      targetType: 'message',
      targetId: messageId,
      metadata: { channelId },
    }).catch((err) => console.error('[audit] message.delete failed:', (err as Error).message));
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json(
      { error: 'Failed to delete message' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'messages-get-one', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const PATCH = withApiSecurity(handlePatch, {
  allowedMethods: ['PATCH'],
  rateLimit: { identifier: 'messages-patch', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const DELETE = withApiSecurity(handleDelete, {
  allowedMethods: ['DELETE'],
  rateLimit: { identifier: 'messages-delete', config: { windowMs: 60_000, maxRequests: 10 } },
});
