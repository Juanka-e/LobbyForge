/**
 * A timed-out member manages nothing (security review 2026-10, A1).
 *
 * The moderation gate (lib/member-authorization.ts) and the unban route
 * already refused a timed-out moderator, but every other management power
 * survived the timeout: approving join requests, editing roles and
 * channels, deleting other members' messages, closing their polls,
 * revoking invites and changing the community's settings, apps, bots and
 * webhooks. Every one of those routes asks this helper, after it has
 * authenticated the caller and found the server and before it writes
 * anything, so the refusal is the same everywhere:
 *
 *   403 { error, code: 'actor_timed_out', until }
 *
 * Clients say it in words from the `code` (lib/profile-action-errors.ts,
 * `timedOutRefusalKey`). The owner cannot be timed out, so the owner is
 * never refused (and never costs a query).
 */
import { NextResponse } from 'next/server';
import { getActiveMemberTimeout } from '@lobbyforge/db';
import { getDb } from '@/lib/db';

export const ACTOR_TIMED_OUT_CODE = 'actor_timed_out';

/** The refusal body for a timed-out actor (until = when the timeout ends). */
export function actorTimedOutResponse(until: Date): NextResponse {
  return NextResponse.json(
    { error: 'You are timed out in this server', code: ACTOR_TIMED_OUT_CODE, until: until.toISOString() },
    { status: 403, headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * The 403 for an actor who is timed out in `serverId`, or null when they
 * may act (not timed out, or the owner).
 */
export async function refuseTimedOutActor(
  serverId: string,
  userId: string,
  ownerUserId: string | null | undefined
): Promise<NextResponse | null> {
  if (ownerUserId && ownerUserId === userId) return null;
  const until = await getActiveMemberTimeout(getDb(), serverId, userId);
  return until ? actorTimedOutResponse(until) : null;
}

/**
 * A request that changes something. The bot and webhook manager gates
 * serve reads and writes alike; a timed-out manager may still LOOK at the
 * settings (reading is not acting), so only writes are refused.
 */
export function isWriteRequest(req: Request): boolean {
  const method = req.method.toUpperCase();
  return method !== 'GET' && method !== 'HEAD';
}
