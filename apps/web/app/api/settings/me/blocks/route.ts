import { NextResponse } from 'next/server';
import { z } from 'zod';
import { blockUser, listBlockedUsers } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET    /api/settings/me/blocks        -> { blocks: UserBlockRow[] }
 * POST   /api/settings/me/blocks        { userId } -> { success: true }
 * DELETE /api/settings/me/blocks/[uid]  -> { success: true }
 *
 * Blocks are directional: the caller only manages their own block list.
 */

async function handleGet(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  const blocks = await listBlockedUsers(getDb(), session.session.uid);
  return NextResponse.json({ blocks }, { headers: { 'Cache-Control': 'no-store' } });
}

const BlockSchema = z.object({ userId: z.string().uuid() }).strict();

async function handlePost(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  let body: z.infer<typeof BlockSchema>;
  try {
    body = BlockSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Expected { userId: string }.' }, { status: 400 });
  }
  try {
    await blockUser(getDb(), session.session.uid, body.userId);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Failed to block user.' }, { status: 400 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'blocks-list', config: { windowMs: 60_000, maxRequests: 20 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'blocks-create', config: { windowMs: 60_000, maxRequests: 10 } },
});

