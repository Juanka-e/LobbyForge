import { NextResponse } from 'next/server';
import { z } from 'zod';
import { reviewPlugin, type PluginReviewStatus } from '@lobbyforge/db';
import { requireAdminHealthToken } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ReviewSchema = z.object({
  pluginId: z.string().min(2).max(128),
  decision: z.enum(['approved', 'rejected', 'delisted']),
  note: z.string().max(1000).nullable().optional(),
}).strict();

/**
 * POST /api/marketplace/review — admin review of a submitted plugin.
 * Approve / reject / delist. Admin-only (requireAdminHealthToken).
 * The reviewerUserId is extracted from the admin session.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const denied = await requireAdminHealthToken(req);
  if (denied) return denied;

  let body: z.infer<typeof ReviewSchema>;
  try {
    body = ReviewSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const db = getDb();
    // The reviewer is the admin — we use a system id since admin-auth is
    // token-based (no user session). A future improvement ties this to the
    // owner session's uid.
    await reviewPlugin(
      db,
      body.pluginId,
      body.decision as PluginReviewStatus,
      '00000000-0000-0000-0000-000000000000', // system admin id
      body.note ?? null
    );
    return NextResponse.json({ ok: true, pluginId: body.pluginId, decision: body.decision });
  } catch {
    return NextResponse.json({ error: 'Failed to review plugin' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 2048,
  rateLimit: { identifier: 'marketplace-review', config: { windowMs: 60_000, maxRequests: 20 } },
});
