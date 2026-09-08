import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  listInstanceReports,
  listPendingSubmissions,
  listPublicRegistryInstances,
  setInstanceReportStatus,
  setRegistryInstanceListing,
} from '@lobbyforge/db';
import { requireAdminHealthToken } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { readGuestSession } from '@/lib/guest-session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/moderation — the admin moderation dashboard data.
 * Returns pending plugin submissions + all registry instances (for
 * block/unlist moderation). Admin-only.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  const denied = await requireAdminHealthToken(req);
  if (denied) return denied;

  try {
    const db = getDb();
    const [pendingPlugins, registryInstances, reports] = await Promise.all([
      listPendingSubmissions(db, { limit: 50 }),
      listPublicRegistryInstances(db, { limit: 200 }),
      listInstanceReports(db, { limit: 100 }),
    ]);
    return NextResponse.json(
      {
        pendingPlugins: pendingPlugins.map((p) => ({
          pluginId: p.pluginId,
          name: p.name,
          version: p.version,
          publisher: p.publisher,
          category: p.category,
          summary: p.summary,
          submittedAt: p.createdAt.toISOString(),
        })),
        registryInstances: registryInstances.map((i) => ({
          instanceId: i.instanceId,
          name: i.name,
          domain: i.domain,
          isVerified: i.isVerified,
          isListed: i.isListed,
          isBlocked: i.isBlocked,
          onlineUsers: i.onlineUsers,
          lastHeartbeatAt: i.lastHeartbeatAt?.toISOString() ?? null,
        })),
        reports: reports.map((r) => ({
          id: r.id,
          instanceId: r.instanceId,
          reporterName: r.reporterName,
          reason: r.reason,
          detail: r.detail,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        })),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ error: 'Failed to load moderation data' }, { status: 500 });
  }
}

const ModerationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('instance'),
    instanceId: z.string().min(3).max(128),
    action: z.enum(['list', 'unlist', 'block']),
  }),
  z.object({
    type: z.literal('report'),
    reportId: z.string().uuid(),
    action: z.enum(['dismiss', 'actioned']),
  }),
]);

/**
 * POST /api/admin/moderation — apply a moderation decision: list/unlist/
 * block a directory instance, or resolve a filed report.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const denied = await requireAdminHealthToken(req);
  if (denied) return denied;

  let body: z.infer<typeof ModerationActionSchema>;
  try {
    body = ModerationActionSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const db = getDb();
    if (body.type === 'instance') {
      await setRegistryInstanceListing(db, body.instanceId, {
        ...(body.action === 'list' ? { isListed: true } : {}),
        ...(body.action === 'unlist' ? { isListed: false } : {}),
        ...(body.action === 'block' ? { isBlocked: true, isListed: false } : {}),
      });
      return NextResponse.json({ ok: true });
    }

    // Report resolution — attribute the decision to the acting admin
    // session when available (emergency-token admins stay anonymous).
    const secret = process.env.LOBBYFORGE_SESSION_SECRET;
    const session = secret ? readGuestSession(req.headers.get('cookie'), secret) : null;
    const updated = await setInstanceReportStatus(
      db,
      body.reportId,
      body.action === 'dismiss' ? 'dismissed' : 'actioned',
      session?.uid ?? null
    );
    if (!updated) {
      return NextResponse.json({ error: 'Report not found or already resolved' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Moderation action failed' }, { status: 500 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'admin-moderation', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 2048,
  rateLimit: { identifier: 'admin-moderation-post', config: { windowMs: 60_000, maxRequests: 30 } },
});
