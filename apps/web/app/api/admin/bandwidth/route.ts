import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { getInstanceSetupStatus, listServersForUser } from '@lobbyforge/db';
import { cookies } from 'next/headers';
import { getServerBandwidthTotals, clearBandwidthAlert } from '@/lib/redis';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * M21.5-bandwidth — admin bandwidth counter + alert.
 *
 * GET  /api/admin/bandwidth
 *   → { totals: { serverId, serverName, totalBytes, todayBytes, alertTriggered, hourly }[] }
 *
 * POST /api/admin/bandwidth { action: 'acknowledge-alert' }
 *   → clears the alert flag for the specified server.
 *
 * Auth: instance admin (owner session or `LOBBYFORGE_ADMIN_TOKEN` cookie).
 * The route never exposes per-user bandwidth — only per-server totals.
 */

async function handleGet(): Promise<NextResponse> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return NextResponse.json({ error: 'Admin token required.' }, { status: 403 });
  }
  const setup = await getInstanceSetupStatus(getDb());
  if (!setup.ownerUserId) {
    return NextResponse.json({ totals: [] });
  }
  const servers = await listServersForUser(getDb(), setup.ownerUserId, { limit: 50 });
  const totals = await Promise.all(
    servers.map(async (s) => {
      const snap = await getServerBandwidthTotals(s.id, { hours: 24 }).catch(() => ({
        totalBytes: 0,
        todayBytes: 0,
        hourly: [],
        alertTriggered: false,
      }));
      return {
        serverId: s.id,
        serverName: s.name,
        totalBytes: snap.totalBytes,
        todayBytes: snap.todayBytes,
        alertTriggered: snap.alertTriggered,
        hourly: snap.hourly,
      };
    })
  );
  return NextResponse.json({ totals }, { headers: { 'Cache-Control': 'no-store' } });
}

const PostSchema = z.object({
  action: z.literal('acknowledge-alert'),
  serverId: z.string().uuid(),
});

async function handlePost(req: Request): Promise<NextResponse> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return NextResponse.json({ error: 'Admin token required.' }, { status: 403 });
  }
  let body: z.infer<typeof PostSchema>;
  try {
    body = PostSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body.' }, { status: 400 });
  }
  await clearBandwidthAlert(body.serverId).catch(() => undefined);
  return NextResponse.json({ success: true });
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'admin-bandwidth-get', config: { windowMs: 60_000, maxRequests: 30 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'admin-bandwidth-post', config: { windowMs: 60_000, maxRequests: 10 } },
});
