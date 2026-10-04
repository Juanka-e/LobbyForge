/**
 * GET /api/plugin-ui/{pluginId} → { frame: { pluginId, version, hasProjection } }
 *
 * Tells the lobby whether a marketplace plugin has a sandboxed UI (ADR-007),
 * the version to frame (the active one — the asset route serves no other)
 * and whether its state is projected per viewer. 404 `{ frame: null }` when
 * there is nothing to frame. Signed-in users only: unlike the assets, the
 * list of what an instance has installed is not handed to anonymous callers.
 */
import { NextResponse } from 'next/server';
import { requireMaterializedSession } from '@/lib/api-auth';
import { describePluginFrame } from '@/lib/plugin-frame-info';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ pluginId: string }> };

async function handleGet(req: Request, ctx: Ctx): Promise<NextResponse> {
  const auth = requireMaterializedSession(req);
  if (!auth.ok) return auth.response;
  const { pluginId } = await ctx.params;
  const frame = typeof pluginId === 'string' ? describePluginFrame(pluginId) : null;
  return NextResponse.json(
    { frame },
    { status: frame ? 200 : 404, headers: { 'Cache-Control': 'no-store' } }
  );
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'plugin-ui-info', config: { windowMs: 60_000, maxRequests: 60 } },
});
