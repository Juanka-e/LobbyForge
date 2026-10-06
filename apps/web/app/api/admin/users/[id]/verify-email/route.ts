import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getInstanceBootstrapStatus, getUserEmailState, logAction, markUserEmailVerified } from '@lobbyforge/db';
import { requireInstanceAdmin } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
const IdSchema = z.string().uuid();

function actorUserId(req: Request): string | null {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  return readGuestSession(req.headers.get('cookie'), secret)?.uid ?? null;
}

/**
 * POST /api/admin/users/{id}/verify-email (docs/EMAIL.md §5) — the owner
 * marks an account's address verified (for a user whose verification email
 * keeps landing in spam, say). Audited as `user.email_verified_by_admin`.
 *
 * 200 { verified: true } (also when it already was — then nothing is
 * written); 400 no_email (a guest, or an account without an address);
 * 404 not_found.
 */
async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const denied = await requireInstanceAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const userId = IdSchema.safeParse(id);
  if (!userId.success) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });

  const user = await getUserEmailState(getDb(), userId.data);
  if (!user || user.deletedAt) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  if (user.isGuest || !user.email) return NextResponse.json({ error: 'no_email' }, { status: 400, headers: NO_STORE });
  if (user.emailVerifiedAt) return NextResponse.json({ verified: true }, { headers: NO_STORE });

  if (!(await markUserEmailVerified(getDb(), user.id))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }
  try {
    const setup = await getInstanceBootstrapStatus(getDb());
    await logAction(getDb(), {
      serverId: setup.firstServerId ?? null,
      actorUserId: actorUserId(req),
      action: 'user.email_verified_by_admin',
      targetType: 'user',
      targetId: user.id,
      metadata: {},
    });
  } catch (error) {
    console.error('[admin/users/verify-email] audit log write failed', JSON.stringify((error as Error).message));
  }
  return NextResponse.json({ verified: true }, { headers: NO_STORE });
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 1024,
  rateLimit: { identifier: 'admin-user-verify-email', config: { windowMs: 60_000, maxRequests: 30 } },
});
