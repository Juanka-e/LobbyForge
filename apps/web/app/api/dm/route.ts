import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  findOrCreateDmChannel,
  getBlockedUserIds,
  getDmRecipientEligibility,
  listDmChannelsForUser,
} from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { projectDmChannel } from '@/lib/profile-privacy';
import { requireVerifiedEmail } from '@/lib/mail/verification';

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
    // security-review FILE-001 / AUTHZ-005: a short avatar URL (never the
    // data URL), and only when the other user's profile visibility allows it.
    const filtered = channels
      .filter((c) => !blockedIds.has(c.otherUserId))
      .map((c) => projectDmChannel(c, uid));
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
 * POST /api/dm — open (or reuse) a DM channel with another user.
 *
 * Security review (needs verification #4): any user id used to work —
 * a DM with someone the caller shares no community with — and an unknown
 * id answered 500 (the FK error), which told ids that exist from ids that
 * do not. The recipient must now be a live user who shares a community
 * with the caller (both current members, neither banned), or one the
 * caller already has a conversation with; everything else is the same
 * 404. Blocks keep their 403, in either direction.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;
  const { uid } = sessionResult.session;
  // docs/EMAIL.md §4.2: an unverified account in `required` mode may read, not do this.
  const unverified = await requireVerifiedEmail(uid, 'dm');
  if (unverified) return unverified;

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
    const eligibility = await getDmRecipientEligibility(db, uid, body.recipientUserId);
    if (!eligibility.exists || (!eligibility.sharesServer && !eligibility.existingChannelId)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
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
