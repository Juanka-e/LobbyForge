import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  isDmChannelParticipant,
  checkDmChannelAccess,
  getDmMessageById,
  listDmMessages,
  sendDmMessage,
  deleteDmMessage,
  getDmChannelParticipants,
} from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { publishDmMessage } from '@/lib/dm-bus';
import { publishDmActivity } from '@/lib/dm-notify';
import { requireVerifiedEmail } from '@/lib/mail/verification';
import { MESSAGE_BODY_MAX_BYTES } from '@/lib/message-limits';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A channel id Postgres can compare: anything else is simply not found (it used to throw a 500). */
function isChannelId(channelId: string): boolean {
  return z.string().uuid().safeParse(channelId).success;
}

/**
 * The page query, or a 400 for junk (security review 2026-10, A9 — `limit`
 * and `before` reached the query unchecked: NaN and Invalid Date threw a
 * 500). `limit` is an integer, clamped to 1..100 (default 50); `before` is
 * a date (the list is newest first, so it pages back in time).
 */
function readPage(url: URL): { ok: true; limit: number; before?: Date } | { ok: false; response: NextResponse } {
  const limitParam = url.searchParams.get('limit');
  const beforeParam = url.searchParams.get('before');
  let limit = 50;
  if (limitParam !== null) {
    if (!/^-?\d{1,9}$/.test(limitParam.trim())) {
      return { ok: false, response: NextResponse.json({ error: 'Invalid `limit`' }, { status: 400 }) };
    }
    limit = Math.max(1, Math.min(100, Number.parseInt(limitParam, 10)));
  }
  let before: Date | undefined;
  if (beforeParam !== null) {
    before = new Date(beforeParam);
    if (!beforeParam.trim() || Number.isNaN(before.getTime())) {
      return { ok: false, response: NextResponse.json({ error: 'Invalid `before` cursor' }, { status: 400 }) };
    }
  }
  return { ok: true, limit, ...(before ? { before } : {}) };
}

/**
 * GET /api/dm/{channelId}/messages — list messages in a DM channel (paginated).
 * Only participants can read. Soft-deleted messages have their content masked.
 */
async function handleGet(
  req: Request,
  ctx: { params: Promise<{ channelId: string }> }
): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;
  const { uid } = sessionResult.session;
  const { channelId } = await ctx.params;
  if (!isChannelId(channelId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const page = readPage(new URL(req.url));
  if (!page.ok) return page.response;

  try {
    const db = getDb();
    const isParticipant = await isDmChannelParticipant(db, channelId, uid);
    if (!isParticipant) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const messages = await listDmMessages(db, channelId, {
      limit: page.limit,
      ...(page.before ? { before: page.before } : {}),
    });
    // Mask soft-deleted messages.
    const masked = messages.map((m) => ({
      id: m.id,
      authorId: m.authorId,
      content: m.deletedAt ? '' : m.content,
      deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
      replyToId: m.replyToId,
      createdAt: m.createdAt.toISOString(),
    }));
    return NextResponse.json(
      { messages: masked },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ error: 'Failed to load messages' }, { status: 500 });
  }
}

const SendMessageSchema = z.object({
  content: z.string().min(1).max(4000),
  replyToId: z.string().uuid().nullable().optional(),
}).strict();

/**
 * POST /api/dm/{channelId}/messages — send a DM message.
 * LF-SEC-006: the block check runs against the EXISTING channel too —
 * the old code only checked participation, so a channel created before
 * a block stayed usable. Communication freezes in both directions
 * (history stays readable — documented product policy).
 */
async function handlePost(
  req: Request,
  ctx: { params: Promise<{ channelId: string }> }
): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;
  const { uid } = sessionResult.session;
  const { channelId } = await ctx.params;
  // docs/EMAIL.md §4.2: an unverified account in `required` mode may read, not do this.
  const unverified = await requireVerifiedEmail(uid, 'dm');
  if (unverified) return unverified;
  if (!isChannelId(channelId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let body: z.infer<typeof SendMessageSchema>;
  try {
    body = SendMessageSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const db = getDb();
  const access = await checkDmChannelAccess(db, channelId, uid, 'send');
  if (access === 'not_found' || access === 'not_participant') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (access === 'blocked') {
    return NextResponse.json(
      { error: 'You cannot send messages in this conversation' },
      { status: 403 }
    );
  }

  // 9th-audit: a reply target must belong to THIS conversation — the
  // old code accepted any message id (DB integrity break; a future
  // reply hydration would turn it into a confidentiality bug).
  if (body.replyToId) {
    const replyTarget = await getDmMessageById(db, body.replyToId);
    if (!replyTarget || replyTarget.dmChannelId !== channelId) {
      return NextResponse.json(
        { error: 'Reply target is not in this conversation' },
        { status: 400 }
      );
    }
  }

  try {
    const message = await sendDmMessage(db, channelId, uid, body.content, body.replyToId ?? null);
    // Fire-and-forget realtime publish (WS-gateway picks this up when the
    // `dm` topic kind is wired; polling fallback works today).
    publishDmMessage({
      channelId,
      message: {
        id: message.id,
        dmChannelId: channelId,
        authorId: message.authorId,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      },
    });
    // Both participants' DM lists hear it — a first message from someone
    // new shows up in the recipient's list without a reload.
    void Promise.resolve()
      .then(() => getDmChannelParticipants(db, channelId))
      .then((pair) => {
        if (pair) publishDmActivity({ channelId, authorId: uid, participantIds: [pair.userAId, pair.userBId] });
      })
      .catch(() => {});
    return NextResponse.json(
      {
        message: {
          id: message.id,
          authorId: message.authorId,
          content: message.content,
          replyToId: message.replyToId,
          createdAt: message.createdAt.toISOString(),
        },
      },
      { status: 201 }
    );
  } catch {
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'dm-messages-list', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  // The same cap as channel messages (lib/message-limits.ts): the old 8 KiB
  // refused a legitimate 4000-character message in a 3-byte script.
  maxBodyBytes: MESSAGE_BODY_MAX_BYTES,
  rateLimit: { identifier: 'dm-messages-send', config: { windowMs: 60_000, maxRequests: 60 } },
});
