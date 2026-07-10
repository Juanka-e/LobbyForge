import { NextResponse } from 'next/server';
import { z } from 'zod';
import { unblockUser } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ParamsSchema = z.object({ userId: z.string().uuid() }).strict();

/**
 * DELETE /api/settings/me/blocks/[userId] -> { success: true }
 * Unblock a previously blocked user.
 */
async function handleDelete(
  req: Request,
  ctx: { params: Promise<{ userId: string }> }
): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  const parsed = ParamsSchema.safeParse(await ctx.params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid blocked user id.' }, { status: 400 });
  }
  const { userId } = parsed.data;
  await unblockUser(getDb(), session.session.uid, userId);
  return NextResponse.json({ success: true });
}

export const DELETE = withApiSecurity(handleDelete, {
  allowedMethods: ['DELETE'],
  rateLimit: { identifier: 'blocks-delete', config: { windowMs: 60_000, maxRequests: 10 } },
});

