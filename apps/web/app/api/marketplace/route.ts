import { NextResponse } from 'next/server';
import { listApprovedPlugins } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/marketplace — browse approved community plugins.
 * Public (no auth) so prospective users can browse before joining.
 * Supports category + search query params.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const category = url.searchParams.get('category');
  const search = url.searchParams.get('q');
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number(limitParam) : 50;

  try {
    const db = getDb();
    const plugins = await listApprovedPlugins(db, {
      category: category || null,
      search: search || null,
      limit,
    });
    return NextResponse.json(
      {
        plugins: plugins.map((p) => ({
          pluginId: p.pluginId,
          name: p.name,
          version: p.version,
          type: p.type,
          summary: p.summary,
          publisher: p.publisher,
          trustLevel: p.trustLevel,
          category: p.category,
          tags: p.tags,
          permissions: p.permissions,
          playerConfig: p.playerConfig,
          iconUrl: p.iconUrl,
          requiresVoiceRoom: p.requiresVoiceRoom,
          downloadCount: p.downloadCount,
        })),
      },
      { headers: { 'Cache-Control': 'public, max-age=30' } }
    );
  } catch {
    return NextResponse.json({ error: 'Failed to load marketplace' }, { status: 500 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'marketplace-browse', config: { windowMs: 60_000, maxRequests: 60 } },
});
