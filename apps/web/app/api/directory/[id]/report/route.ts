import { NextResponse } from 'next/server';
import { z } from 'zod';
import { instanceReports } from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ReportSchema = z.object({
  reason: z.enum(['spam', 'nsfw', 'abuse', 'malware', 'other']),
  detail: z.string().max(1000).optional(),
}).strict();

/**
 * POST /api/directory/{id}/report — file a complaint about a discovery
 * directory instance. Auth/guest-aware, rate-limited.
 */
async function handlePost(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: instanceId } = await ctx.params;
  const sessionResult = requireMaterializedSession(req);
  // Reports can be filed by guests (uid may be null) — we just need a session.
  const reporterUserId = sessionResult.ok ? sessionResult.session.uid : null;

  let body: z.infer<typeof ReportSchema>;
  try {
    body = ReportSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid report body' }, { status: 400 });
  }

  try {
    const db = getDb();
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
