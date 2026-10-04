import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRegistryInstanceByInstanceId, instanceReports } from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { directoryWritesUnavailable } from '@/lib/directory-verification';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ReportSchema = z.object({
  reason: z.enum(['spam', 'nsfw', 'abuse', 'malware', 'other']),
  detail: z.string().max(1000).optional(),
}).strict();

/**
 * POST /api/directory/{id}/report — file a complaint about a discovery
 * directory instance (`{id}` is its directory instance id). Auth/guest-aware,
 * rate-limited; 404 for an id the directory does not know.
 */
async function handlePost(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  // security-review FILE-002: the directory is served by the official hub only.
  const unavailable = directoryWritesUnavailable();
  if (unavailable) return unavailable;

  const { id: instanceId } = await ctx.params;
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;
  const reporterUserId = sessionResult.session.uid;

  let body: z.infer<typeof ReportSchema>;
  try {
    body = ReportSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid report body' }, { status: 400 });
  }

  try {
    const db = getDb();
    // Only an entry the directory knows can be reported: a made-up id used
    // to be stored as a report about nothing, flooding the moderation queue.
    const entry = await getRegistryInstanceByInstanceId(db, instanceId);
    if (!entry) {
      return NextResponse.json({ error: 'Directory entry not found' }, { status: 404 });
    }
    await db.insert(instanceReports).values({
      instanceId,
      reporterUserId,
      reason: body.reason,
      detail: body.detail ?? null,
      status: 'pending',
    });
    return NextResponse.json({ ok: true, message: 'Report submitted. Thank you.' }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Failed to submit report' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 2048,
  rateLimit: { identifier: 'instance-report', config: { windowMs: 60_000, maxRequests: 3 } },
});
