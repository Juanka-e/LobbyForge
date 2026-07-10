import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireTestResetAccess } from '@/lib/test-reset-auth';
import { sql } from '@lobbyforge/db';

export async function POST(req: Request) {
  const denied = requireTestResetAccess(req);
  if (denied) return denied;

  const db = getDb();
  // Truncate tables to ensure isolation
  await db.execute(sql`TRUNCATE TABLE memberships, servers, users, invites CASCADE;`);
  return NextResponse.json({ ok: true });
}
