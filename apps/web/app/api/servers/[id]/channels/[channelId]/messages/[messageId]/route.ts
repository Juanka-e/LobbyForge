import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CorePermission, hasPermission, MessageContentSchema } from '@lobbyforge/core';
import {
  getChannelById,
  getMessageById,
  getServerById,
  getUserPermissions,
  isServerMember,
  logAction,
  softDeleteMessage,
  updateMessage,
  type MessageRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';

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
 * Authorization for message-level routes. The caller is allowed to:
 *   - read the message if they are a member of the parent server.
 *   - edit / delete the message if they are the author OR have
 *     `MANAGE_MESSAGES` on the server (typically the owner or anyone
 *     with the @admin role).
 */
async function loadAndAuthorize(
  serverId: string,
  channelId: string,
  messageId: string,
  userId: string
): Promise<AuthorizeResult | AuthorizeError> {
  if (!serverId || !channelId || !messageId) {
    return { ok: false, response: NextResponse.json({ error: 'Server, channel, and message ids are required' }, { status: 400 }) };
  }

  const server = await getServerById(getDb(), serverId);
  if (!server) {
    return { ok: false, response: NextResponse.json({ error: 'Server not found' }, { status: 404 }) };
  }
  const isOwner = server.ownerUserId === userId;
  if (!isOwner) {
    const member = await isServerMember(getDb(), userId, serverId);
    if (!member) {
      return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
  }

  const channel = await getChannelById(getDb(), channelId);
  if (!channel || channel.serverId !== serverId) {
    return { ok: false, response: NextResponse.json({ error: 'Channel not found' }, { status: 404 }) };
  }

  const message = await getMessageById(getDb(), messageId);
  if (!message || message.channelId !== channelId) {
    return { ok: false, response: NextResponse.json({ error: 'Message not found' }, { status: 404 }) };
  }

  return { ok: true, message, isOwner, isAuthor: message.userId === userId };
}

/**
 * Mutation gate for PATCH / DELETE. The caller may proceed if they are
 * the author OR if they have MANAGE_MESSAGES on the server.
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
    const access = await loadAndAuthorize(serverId, channelId, messageId, session.uid);
    if (!access.ok) return access.response;
    return NextResponse.json(
      { message: toJson(access.message) },
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
    const access = await loadAndAuthorize(serverId, channelId, messageId, session.uid);
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

    if (body.content !== undefined && !(await canMutateMessage(serverId, access.isAuthor, session.uid))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
    const access = await loadAndAuthorize(serverId, channelId, messageId, session.uid);
    if (!access.ok) return access.response;

    if (!(await canMutateMessage(serverId, access.isAuthor, session.uid))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await softDeleteMessage(getDb(), messageId);
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
