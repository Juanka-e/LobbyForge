import { NextResponse } from 'next/server';
import { listPendingSubmissions, listPublicRegistryInstances } from '@lobbyforge/db';
import { requireAdminHealthToken } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

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
    const [pendingPlugins, registryInstances] = await Promise.all([
      listPendingSubmissions(db, { limit: 50 }),
      listPublicRegistryInstances(db, { limit: 200 }),
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
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ error: 'Failed to load moderation data' }, { status: 500 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'admin-moderation', config: { windowMs: 60_000, maxRequests: 30 } },
});
