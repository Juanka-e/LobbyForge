import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireTestResetAccess } from '@/lib/test-reset-auth';
import { withApiSecurity } from '@/lib/security-headers';
import { sql } from '@lobbyforge/db';

async function handlePost(req: Request): Promise<NextResponse> {
  const denied = requireTestResetAccess(req);
  if (denied) return denied;

  const db = getDb();
  // Truncate tables to ensure isolation
  await db.execute(sql`TRUNCATE TABLE memberships, servers, users, invites CASCADE;`);
  return NextResponse.json({ ok: true });
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maintenanceMode: 'bypass',
  sessionRevocation: 'bypass',
  maxBodyBytes: 0,
  rateLimit: { identifier: 'test-db-reset', config: { windowMs: 60_000, maxRequests: 5 } },
});
