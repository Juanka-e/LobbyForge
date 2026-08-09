import { NextResponse } from 'next/server';
import { z } from 'zod';
import { heartbeatRegistryInstance } from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HeartbeatSchema = z.object({
  instanceId: z.string().min(3).max(128),
  onlineUsers: z.number().int().min(0).max(1_000_000).optional(),
  publicRoomsCount: z.number().int().min(0).max(100_000).optional(),
  version: z.string().max(60).optional(),
  doctorScore: z.number().int().min(0).max(100).optional(),
}).strict();

/**
 * POST /api/directory/heartbeat — update live stats for a registered instance.
 *
 * Called periodically by self-hosted instances to report their current load.
 * No auth (the instance's publicKey is verified out-of-band in a future
 * Requires a materialized session to prevent anonymous stats spoofing.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;

  let body: z.infer<typeof HeartbeatSchema>;
  try {
    body = HeartbeatSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const db = getDb();
    await heartbeatRegistryInstance(db, body.instanceId, {
      onlineUsers: body.onlineUsers,
      publicRoomsCount: body.publicRoomsCount,
      version: body.version,
      doctorScore: body.doctorScore,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Failed to record heartbeat' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 1024,
  rateLimit: { identifier: 'directory-heartbeat', config: { windowMs: 60_000, maxRequests: 10 } },
});
