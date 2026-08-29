import { NextResponse } from 'next/server';
import { z } from 'zod';
import { MessageContentSchema } from '@lobbyforge/core';
import {
  createMessage,
  getActiveMemberTimeout,
  getChannelById,
  getServerById,
  getBlockedUserIds,
  isServerMember,
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
import { publishChatMessage } from '@/lib/chat-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CreateMessageSchema = z.object({
  content: MessageContentSchema,
  replyToId: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const RESERVED_METADATA_KEYS = new Set([
  'system',
  'plugin',
  'bot',
  'app',
  'trust',
  'signature',
  'moderation',
]);

function validateUserMetadata(metadata: Record<string, unknown> | undefined): NextResponse | null {
  if (!metadata) return null;
  for (const key of Object.keys(metadata)) {
    if (key.startsWith('$') || key.startsWith('_') || RESERVED_METADATA_KEYS.has(key)) {
      return NextResponse.json(
        { error: 'Message metadata contains reserved keys', key },
        { status: 400 }
      );
    }
  }
  return null;
}

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

/**
 * Authorization for messages: the caller must be a member of the parent
 * server, and the channel + server must both exist / not be soft-deleted.
 * The owner-only "edit / delete" rules are handled in the [messageId] route
 * — this layer just gates "can you read / write messages here at all".
 */
async function assertMemberAndChannel(
  serverId: string,
  channelId: string,
  userId: string
): Promise<
  | { ok: true }
  | { ok: false; response: NextResponse }
> {
  if (!serverId || !channelId) {
    return { ok: false, response: NextResponse.json({ error: 'Server id and channel id are required' }, { status: 400 }) };
  }
  const server = await getServerById(getDb(), serverId);
  if (!server) {
    return { ok: false, response: NextResponse.json({ error: 'Server not found' }, { status: 404 }) };
  }
  const member = await isServerMember(getDb(), userId, serverId);
  if (!member) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  const channel = await getChannelById(getDb(), channelId);
  if (!channel) {
    return { ok: false, response: NextResponse.json({ error: 'Channel not found' }, { status: 404 }) };
  }
  if (channel.serverId !== serverId) {
    return { ok: false, response: NextResponse.json({ error: 'Channel not found' }, { status: 404 }) };
  }
  // Role-gated visibility (0028) — owner/manage_channels bypass inside.
  const visibility = await authorizeChannelVisibility(
    userId,
    serverId,
    channelId,
    server.ownerUserId ?? null
  );
  if (!visibility.ok) return visibility;
  return { ok: true };
}

async function handleGet(
  req: Request,
  ctx: { params: Promise<{ id: string; channelId: string }> }
): Promise<NextResponse> {
  const { id: serverId, channelId } = await ctx.params;

  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const access = await assertMemberAndChannel(serverId, channelId, session.uid);
    if (!access.ok) return access.response;

    // READ_MESSAGE_HISTORY: membership alone is not enough — a role can
    // revoke history (write-only channels, announcement-style rooms).
    const historyAuth = await authorizeServerPermission(
      session.uid,
      serverId,
      CorePermission.READ_MESSAGE_HISTORY
    );
    if (!historyAuth.ok) return historyAuth.response;

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
    const messages = rows.map((m) => {
      const json = toJson(m);
      if (m.userId && blockedIds.has(m.userId)) {
        return {
          ...json,
          blocked: true,
          content: '🚫 Blocked user — message hidden.',
          userId: null,
        };
      }
      return { ...json, blocked: false };
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

  try {
    const access = await assertMemberAndChannel(serverId, channelId, session.uid);
    if (!access.ok) return access.response;

    let body: z.infer<typeof CreateMessageSchema>;
    try {
      const raw = await req.json();
      body = CreateMessageSchema.parse(raw);
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    // Permission check — posting a message requires SEND_MESSAGES. The
    // owner has it via @admin; members of the server have it via the
    // @everyone default role seeded on server creation.
    const auth = await authorizeServerPermission(session.uid, serverId, CorePermission.SEND_MESSAGES);
    if (!auth.ok) return auth.response;

    // MODERATE_MEMBERS timeout: timed-out members cannot send messages
    // until the timeout expires (cleared with the same endpoint).
    const activeTimeout = await getActiveMemberTimeout(getDb(), serverId, session.uid);
    if (activeTimeout) {
      return NextResponse.json(
        { error: 'You are timed out in this server', until: activeTimeout.toISOString() },
        { status: 403 }
      );
    }

    // MENTION_EVERYONE: @everyone in the content requires the explicit
    // permission (notification-spam control, Discord semantics).
    const mentionsEveryone = /(^|\s)@everyone\b/i.test(body.content);
    if (mentionsEveryone) {
      const mentionAuth = await authorizeServerPermission(
        session.uid,
        serverId,
        CorePermission.MENTION_EVERYONE
      );
      if (!mentionAuth.ok) return mentionAuth.response;
    }
    const metadataError = validateUserMetadata(body.metadata);
    if (metadataError) return metadataError;

    const created = await createMessage(getDb(), {
      channelId,
      userId: session.uid,
      content: body.content,
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
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
  rateLimit: { identifier: 'messages-create', config: { windowMs: 60_000, maxRequests: 30 } },
});
