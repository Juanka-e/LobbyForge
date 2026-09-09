import { NextResponse } from 'next/server';
import { z } from 'zod';
import { reviewPlugin, type PluginReviewStatus } from '@lobbyforge/db';
import { requireAdminHealthToken } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { getCatalogEntry } from '@lobbyforge/db';
import { downloadBundleForReview } from '@/lib/plugin-bundle-download';

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
    // 13th-audit: the reviewer is recorded as NULL for token-based
    // admin reviews — the all-zero UUID violated the users FK on real
    // Postgres (approve → 500). Session-based admin reviews pass their
    // uid; the review note records the decision either way.
    const session = (() => {
      try {
        const secret = process.env.LOBBYFORGE_SESSION_SECRET;
        if (!secret || secret.length < 32) return null;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { readGuestSession } = require('@/lib/guest-session') as typeof import('@/lib/guest-session');
        return readGuestSession(req.headers.get('cookie'), secret);
      } catch {
        return null;
      }
    })();
    // 13th-audit: on APPROVAL, fetch the bundle and pin its digest —
    // installs verify against this, closing the "approved plugin ID,
    // mutable artifact URL" trust gap.
    let bundlePin: { sha256: string; sizeBytes: number } | undefined;
    if (body.decision === 'approved') {
      const entry = await getCatalogEntry(db, body.pluginId);
      if (!entry?.manifestUrl) {
        return NextResponse.json(
          { error: 'Plugin has no manifestUrl — cannot pin an artifact for review' },
          { status: 400 }
        );
      }
      try {
        const { createHash } = await import('node:crypto');
        const bundle = await downloadBundleForReview(entry.manifestUrl);
        bundlePin = {
          sha256: createHash('sha256').update(Buffer.from(bundle)).digest('hex'),
          sizeBytes: bundle.byteLength,
        };
      } catch (err) {
        return NextResponse.json(
          { error: `Could not fetch the bundle for review pinning: ${(err as Error).message}` },
          { status: 400 }
        );
      }
    }
    await reviewPlugin(
      db,
      body.pluginId,
      body.decision as PluginReviewStatus,
      session?.uid ?? null,
      body.note ?? null,
      bundlePin
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
