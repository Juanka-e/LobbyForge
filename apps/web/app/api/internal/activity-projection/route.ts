import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getGameSessionById } from '@lobbyforge/db';
import { ACTIVITY_PROJECTION_PURPOSE, INTERNAL_SIGNATURE_HEADER, verifyInternalRequest } from '@lobbyforge/core';
import { getDb } from '@/lib/db';
import { withMachineApiSecurity } from '@/lib/security-headers';
import { getPluginServer } from '@/lib/plugin-server-registry';
import { projectStateForViewer } from '@/lib/plugin-projection';
import { denyActivityStreamAccess } from '@/lib/activity-stream-authorization';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * INTERNAL endpoint (ADR-007) — the ws-gateway's projection for activities
 * it cannot project itself. A marketplace plugin projects its state with
 * its own `projectState` in the plugin worker, and only this app can reach
 * the worker (its network has no other member). For any plugin id outside
 * core's rules (`isCoreProjectedPlugin`), the gateway asks here, per viewer,
 * and forwards the answer — or, on any failure, no state at all.
 *
 * Never exposed publicly: nginx returns 404 for /api/internal/*, and the
 * request must carry a fresh signature over its exact body
 * (@lobbyforge/core internal-signature, a key derived from
 * LOBBYFORGE_SESSION_SECRET, which the gateway already holds). The viewer's
 * access is re-checked here as well — membership, the session's server and
 * channel visibility — so a projection is never produced for someone who
 * has lost access between the gateway's re-authorizations.
 */

const BodySchema = z.object({
  serverId: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(64),
  viewerUserId: z.string().min(1).max(128),
});

async function handlePost(req: Request): Promise<NextResponse> {
  const raw = await req.text();
  if (
    !verifyInternalRequest(
      process.env.LOBBYFORGE_SESSION_SECRET,
      ACTIVITY_PROJECTION_PURPOSE,
      req.headers.get(INTERNAL_SIGNATURE_HEADER),
      raw
    )
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const row = await getGameSessionById(getDb(), body.sessionId);
    if (!row || row.serverId !== body.serverId) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 });
    }
    const denial = await denyActivityStreamAccess(body.viewerUserId, {
      serverId: body.serverId,
      channelId: null,
      session: row,
    });
    if (denial) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const plugin = getPluginServer(row.pluginId);
    const state = plugin?.migrateState ? await plugin.migrateState(row.state) : row.state;
    const projected = await projectStateForViewer({
      plugin,
      pluginId: row.pluginId,
      state,
      viewerUserId: body.viewerUserId,
      ctx: { sessionId: row.id, serverId: row.serverId, hostUserId: row.createdBy ?? null },
    });
    return NextResponse.json(
      { status: row.status, revision: (row as { revision?: number }).revision ?? null, state: projected },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    console.error('[internal-activity-projection] failed:', JSON.stringify((err as Error).message));
    // Fail closed: the gateway then forwards the event without state.
    return NextResponse.json({ error: 'Projection failed' }, { status: 502 });
  }
}

// MACHINE endpoint — called by the ws-gateway on the compose network; no
// browser Origin, no IP-keyed rate limit (one caller, one address).
export const POST = withMachineApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 4 * 1024,
});
