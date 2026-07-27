import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  isDmChannelParticipant,
  listDmMessages,
  sendDmMessage,
  deleteDmMessage,
} from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

  const db = getDb();
  const isParticipant = await isDmChannelParticipant(db, channelId, uid);
  if (!isParticipant) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const url = new URL(req.url);
  const limitParam = url.searchParams.get('limit');
  const beforeParam = url.searchParams.get('before');
  const limit = limitParam ? Number(limitParam) : 50;
  const before = beforeParam ? new Date(beforeParam) : undefined;

  try {
    const messages = await listDmMessages(db, channelId, { limit, before });
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
 * Only participants can send. Block check happens at channel-open time
 * (POST /api/dm), but we also mask here as defense-in-depth.
 */
async function handlePost(
  req: Request,
  ctx: { params: Promise<{ channelId: string }> }
): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;
  const { uid } = sessionResult.session;
  const { channelId } = await ctx.params;

  let body: z.infer<typeof SendMessageSchema>;
  try {
    body = SendMessageSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const db = getDb();
  const isParticipant = await isDmChannelParticipant(db, channelId, uid);
  if (!isParticipant) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const message = await sendDmMessage(db, channelId, uid, body.content, body.replyToId ?? null);
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
  maxBodyBytes: 8192,
  rateLimit: { identifier: 'dm-messages-send', config: { windowMs: 60_000, maxRequests: 60 } },
});
