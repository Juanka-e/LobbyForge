import { NextResponse } from 'next/server';
import { z } from 'zod';
import { reviewPlugin, type PluginReviewStatus } from '@lobbyforge/db';
import { requireAdminHealthToken } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { getCatalogEntry } from '@lobbyforge/db';
import { downloadBundleForReview } from '@/lib/plugin-bundle-download';
import { missingSandboxRootFiles, scanTarEntries } from '@/lib/plugin-installer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ReviewSchema = z.object({
  pluginId: z.string().min(2).max(128),
  decision: z.enum(['approved', 'rejected', 'delisted']),
  note: z.string().max(1000).nullable().optional(),
  /** The version the reviewer looked at (the moderation screen sends it). */
  version: z.string().min(1).max(30).optional(),
}).strict();

/**
 * POST /api/marketplace/review — admin review of a submitted plugin.
 * Approve / reject / delist. Admin-only (requireAdminHealthToken).
 * The reviewerUserId is extracted from the admin session.
 *
 * `version` (security review): the submission the reviewer saw. When it is
 * not the catalogue row's version any more — the publisher resubmitted in
 * between — the review is refused with 409 `version_changed` and the
 * current version, so nothing is approved unseen. An approval is also
 * written only while the row still has the version and bundle URL that were
 * downloaded and pinned (a resubmission during the download gets the same
 * 409).
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
    // The submission the reviewer saw must still be the one in the catalogue.
    const entry = body.decision === 'approved' || body.version !== undefined
      ? await getCatalogEntry(db, body.pluginId)
      : null;
    if (body.version !== undefined) {
      if (!entry) return NextResponse.json({ error: 'Plugin not found in catalog' }, { status: 404 });
      if (entry.version !== body.version) return versionChanged(entry.version);
    }
    // 13th-audit: on APPROVAL, fetch the bundle and pin its digest —
    // installs verify against this, closing the "approved plugin ID,
    // mutable artifact URL" trust gap.
    let bundlePin: { sha256: string; sizeBytes: number } | undefined;
    if (body.decision === 'approved') {
      if (!entry?.manifestUrl) {
        return NextResponse.json(
          { error: 'Plugin has no manifestUrl — cannot pin an artifact for review' },
          { status: 400 }
        );
      }
      try {
        const { createHash } = await import('node:crypto');
        const bundle = await downloadBundleForReview(entry.manifestUrl);
        // ADR-007: only sandbox-v1 bundles can ever be installed, so refuse
        // to approve (and pin) anything else here instead of letting the
        // owner discover it at install time.
        const scan = scanTarEntries(Buffer.from(bundle));
        if (!scan.ok) {
          return NextResponse.json({ error: `Bundle rejected: ${scan.error}` }, { status: 400 });
        }
        const missing = missingSandboxRootFiles(scan.entries);
        if (missing) {
          return NextResponse.json({ error: `Bundle rejected: ${missing}`, code: 'not_sandbox_bundle' }, { status: 400 });
        }
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
    // Written only while the row is still what was checked (and, for an
    // approval, downloaded): one statement, so a resubmission cannot slip in.
    const expected = entry
      ? { version: entry.version, ...(body.decision === 'approved' ? { manifestUrl: entry.manifestUrl } : {}) }
      : undefined;
    const updated = await reviewPlugin(
      db,
      body.pluginId,
      body.decision as PluginReviewStatus,
      session?.uid ?? null,
      body.note ?? null,
      bundlePin,
      expected
    );
    if (!updated) {
      if (!expected) return NextResponse.json({ error: 'Plugin not found in catalog' }, { status: 404 });
      const current = await getCatalogEntry(db, body.pluginId);
      if (!current) return NextResponse.json({ error: 'Plugin not found in catalog' }, { status: 404 });
      return versionChanged(current.version);
    }
    return NextResponse.json({ ok: true, pluginId: body.pluginId, decision: body.decision });
  } catch {
    return NextResponse.json({ error: 'Failed to review plugin' }, { status: 500 });
  }
}

/** The publisher resubmitted since the reviewer looked: review the new one. */
function versionChanged(currentVersion: string): NextResponse {
  return NextResponse.json(
    {
      error: `The submission changed (now version ${currentVersion}) — review the new version first.`,
      code: 'version_changed',
      version: currentVersion,
    },
    { status: 409 }
  );
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 2048,
  rateLimit: { identifier: 'marketplace-review', config: { windowMs: 60_000, maxRequests: 20 } },
});
