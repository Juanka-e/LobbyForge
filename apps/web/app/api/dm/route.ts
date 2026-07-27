import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findOrCreateDmChannel, listDmChannelsForUser, getBlockedUserIds } from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/dm — list the caller's DM channels (most recently active first).
 * Blocked users are filtered out of the list.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;
  const { uid } = sessionResult.session;

  try {
    const db = getDb();
    const [channels, blockedIds] = await Promise.all([
      listDmChannelsForUser(db, uid),
      getBlockedUserIds(db, uid),
    ]);
    const filtered = channels.filter(
      (c) => !blockedIds.has(c.otherUserId)
    );
    return NextResponse.json(
      { channels: filtered },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ error: 'Failed to load DM channels' }, { status: 500 });
  }
}

const CreateDmSchema = z.object({
  recipientUserId: z.string().uuid(),
}).strict();

/**
 * POST /api/dm — open (or reuse) a DM channel with another user. Returns 403
 * if either party has blocked the other.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;
  const { uid } = sessionResult.session;

  let body: z.infer<typeof CreateDmSchema>;
  try {
    body = CreateDmSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  if (body.recipientUserId === uid) {
    return NextResponse.json({ error: 'Cannot DM yourself' }, { status: 400 });
  }

  try {
    const db = getDb();
    // Block check — either direction blocks the DM.
    const [myBlocks, theirBlocks] = await Promise.all([
      getBlockedUserIds(db, uid),
      getBlockedUserIds(db, body.recipientUserId),
    ]);
    if (myBlocks.has(body.recipientUserId)) {
      return NextResponse.json({ error: 'You have blocked this user' }, { status: 403 });
    }
    if (theirBlocks.has(uid)) {
      return NextResponse.json({ error: 'Cannot send a message to this user' }, { status: 403 });
    }
    const channel = await findOrCreateDmChannel(db, uid, body.recipientUserId);
    return NextResponse.json({ channel }, { status: 200 });
  } catch {
    return NextResponse.json({ error: 'Failed to open DM channel' }, { status: 500 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'dm-list', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 256,
  rateLimit: { identifier: 'dm-create', config: { windowMs: 60_000, maxRequests: 20 } },
});
