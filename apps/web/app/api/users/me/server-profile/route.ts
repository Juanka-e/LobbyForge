import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerById, getServerMember, listServersForUser, updateMemberNickname } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';
import { publishMembersChanged } from '@/lib/member-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ServerProfileSchema = z.object({
  /**
   * The community whose nickname this is. Optional only for older clients:
   * without it the nickname lands in the account's newest community, which
   * is what every request did before — whichever lobby it came from.
   */
  serverId: z.string().uuid().optional(),
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
    return NextResponse.json({ error: 'Invalid server profile payload', code: 'invalid_nickname' }, { status: 400 });
  }

  const db = getDb();
  let serverId: string | null = null;
  if (body.serverId) {
    // A membership in a live server; one answer for "no such community" and
    // "not yours", like every other server route.
    const [server, membership] = await Promise.all([
      getServerById(db, body.serverId),
      getServerMember(db, body.serverId, session.session.uid),
    ]);
    if (server && membership) serverId = server.id;
  } else {
    serverId = (await listServersForUser(db, session.session.uid, { limit: 1 }))[0]?.id ?? null;
  }
  if (!serverId) {
    return NextResponse.json({ error: 'No accessible community.', code: 'no_community' }, { status: 409 });
  }

  const updated = await updateMemberNickname(db, serverId, session.session.uid, body.nickname);
  // docs/PROFILES.md "Live updates": that community's open lobbies show the new name.
  publishMembersChanged(serverId, [session.session.uid]);
  return NextResponse.json(
    { serverProfile: { serverId, nickname: updated.nickname } },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const PATCH = withApiSecurity(handlePatch, {
  allowedMethods: ['PATCH'],
  maxBodyBytes: 1024,
  rateLimit: { identifier: 'user-server-profile-patch', config: { windowMs: 60_000, maxRequests: 20 } },
});
