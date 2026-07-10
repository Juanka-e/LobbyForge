import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listServersForUser, updateMemberNickname } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ServerProfileSchema = z.object({
  nickname: z
    .string()
    .trim()
    .min(2, 'Nickname must be at least 2 characters.')
    .max(64, 'Nickname must be 64 characters or fewer.')
    .regex(/^[^<>{}\u0000-\u001F\u007F]+$/, 'Nickname contains unsupported characters.')
    .nullable(),
}).strict();

async function handlePatch(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  let body: z.infer<typeof ServerProfileSchema>;
  try {
    body = ServerProfileSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid server profile payload' }, { status: 400 });
  }

  const db = getDb();
  const servers = await listServersForUser(db, session.session.uid, { limit: 1 });
  const server = servers[0];
  if (!server) {
    return NextResponse.json({ error: 'No accessible community.' }, { status: 409 });
  }

  const updated = await updateMemberNickname(db, server.id, session.session.uid, body.nickname);
  return NextResponse.json(
    { serverProfile: { serverId: server.id, nickname: updated.nickname } },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const PATCH = withApiSecurity(handlePatch, {
  allowedMethods: ['PATCH'],
  maxBodyBytes: 1024,
  rateLimit: { identifier: 'user-server-profile-patch', config: { windowMs: 60_000, maxRequests: 20 } },
});
