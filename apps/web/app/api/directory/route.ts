import { NextResponse } from 'next/server';
import { listPublicRegistryInstances } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/directory — public discovery directory.
 *
 * Returns listed, non-blocked community instances sorted by online users.
 * Supports optional `region` and `limit` query params. This endpoint is
 * public (no auth) so prospective members can browse before joining.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const region = url.searchParams.get('region');
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number(limitParam) : 50;

  try {
    const db = getDb();
    const instances = await listPublicRegistryInstances(db, {
      limit,
      region: region || null,
    });
    return NextResponse.json(
      {
        instances: instances.map((i) => ({
          instanceId: i.instanceId,
          name: i.name,
          domain: i.domain,
          description: i.description,
          region: i.region,
          languages: i.languages,
          tags: i.tags,
          features: i.features,
          isVerified: i.isVerified,
          nsfw: i.nsfw,
          onlineUsers: i.onlineUsers,
          publicRoomsCount: i.publicRoomsCount,
          version: i.version,
          doctorScore: i.doctorScore,
          lastHeartbeatAt: i.lastHeartbeatAt?.toISOString() ?? null,
        })),
      },
      { headers: { 'Cache-Control': 'public, max-age=30' } }
    );
  } catch {
    return NextResponse.json({ error: 'Failed to load directory' }, { status: 500 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'directory-list', config: { windowMs: 60_000, maxRequests: 60 } },
});
