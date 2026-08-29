import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  getHighestRolePosition,
  getServerById,
  getUserPermissions,
  isServerMember,
  logAction,
  setMemberTimeout,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // 28 days, Discord's cap

const TimeoutSchema = z
  .object({
    /** ISO-8601 instant; null clears an active timeout. */
    until: z.string().datetime().nullable(),
  })
  .strict();

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

async function resolveSession(req: Request): Promise<
  | { ok: true; uid: string }
  | { ok: false; response: NextResponse }
> {
  const session = readGuestSession(req.headers.get('cookie'), getSessionSecret());
  if (!session || !session.uid) {
    return { ok: false, response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }
  return { ok: true, uid: session.uid };
}

/**
 * PUT /api/servers/{id}/members/{userId}/timeout — MODERATE_MEMBERS.
 * The step between a warning and a kick/ban: the member cannot send
 * messages or publish their microphone until `until` (null = clear).
 *
 * Hierarchy (same semantics as role assignment): only the owner acts
 * freely; everyone else needs MODERATE_MEMBERS AND a strictly higher
 * role than the target. The owner can never be timed out.
 */
async function handlePut(
  req: Request,
  ctx: { params: Promise<{ id: string; userId: string }> }
): Promise<NextResponse> {
  const { id: serverId, userId: targetUserId } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const server = await getServerById(getDb(), serverId);
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }
    if (!(await isServerMember(getDb(), session.uid, serverId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const permissions = await getUserPermissions(getDb(), session.uid, serverId);
    if (!hasPermission(permissions, CorePermission.MODERATE_MEMBERS)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    let body: z.infer<typeof TimeoutSchema>;
    try {
      body = TimeoutSchema.parse(await req.json());
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    let until: Date | null = null;
    if (body.until !== null) {
      until = new Date(body.until);
      if (Number.isNaN(until.getTime())) {
        return NextResponse.json({ error: 'Invalid `until` timestamp' }, { status: 400 });
      }
      if (until.getTime() > Date.now() + MAX_TIMEOUT_MS) {
        until = new Date(Date.now() + MAX_TIMEOUT_MS);
      }
    }

    if (targetUserId === server.ownerUserId) {
      return NextResponse.json({ error: 'The server owner cannot be timed out' }, { status: 403 });
    }
    if (!(server.ownerUserId === targetUserId || (await isServerMember(getDb(), targetUserId, serverId)))) {
      return NextResponse.json({ error: 'Target user is not a member of this server' }, { status: 404 });
    }

    // Discord-style hierarchy: the actor's highest role must be strictly
    // above the target's highest role (owner bypasses).
    if (session.uid !== server.ownerUserId) {
      const [actorHighest, targetHighest] = await Promise.all([
        getHighestRolePosition(getDb(), serverId, session.uid),
        getHighestRolePosition(getDb(), serverId, targetUserId),
      ]);
      if (targetHighest >= actorHighest) {
        return NextResponse.json(
          { error: 'You can only time out members below your highest role' },
          { status: 403 }
        );
      }
    }

    const updated = await setMemberTimeout(getDb(), serverId, targetUserId, until);
    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'member.timeout',
      targetType: 'membership',
      targetId: targetUserId,
      metadata: { until: until ? until.toISOString() : null },
    }).catch((err) => console.error('[audit] member.timeout failed:', (err as Error).message));

    return NextResponse.json(
      { timedOutUntil: updated.timedOutUntil ? updated.timedOutUntil.toISOString() : null },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    console.error('[member/timeout] failed:', (err as Error).message);
    return NextResponse.json({ error: 'Failed to update timeout' }, { status: 500 });
  }
}

export const PUT = withApiSecurity(handlePut, {
  allowedMethods: ['PUT'],
  maxBodyBytes: 2048,
  rateLimit: { identifier: 'member-timeout', config: { windowMs: 60_000, maxRequests: 20 } },
});
