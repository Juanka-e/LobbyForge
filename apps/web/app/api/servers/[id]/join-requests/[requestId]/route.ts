import { NextResponse } from 'next/server';
import { z } from 'zod';
import { approveJoinRequest, getUserPermissions, logAction, rejectJoinRequest } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession, requireServerMember } from '@/lib/api-auth';
import { canReviewJoinRequests, isUuid, toDecisionJson } from '@/lib/join-requests';
import { withApiSecurity } from '@/lib/security-headers';
import { notifyMemberJoined } from '@/lib/bots/welcome';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DecisionSchema = z.object({ action: z.enum(['approve', 'reject']) }).strict();

/**
 * POST /api/servers/{id}/join-requests/{requestId} `{ action }` — a
 * moderator (KICK_MEMBERS or MANAGE_SERVER) decides a pending request.
 *
 * approve: the membership is created exactly like the auto-join creates
 * one (@everyone, stored timeout / server mute), the Welcome Bot greets the
 * new member, and `member.join_approved` is audited. No realtime event: a
 * plain join publishes none either (the access-invalidation bus is for
 * LOSING access). A user banned since they asked is not admitted (409
 * `banned`, the request is rejected).
 * reject: `member.join_rejected` is audited; the user cannot ask again for
 * the cooldown (JOIN_REQUEST_REJECTION_COOLDOWN_MS).
 * A request that was already decided answers 409 `not_pending`. A request
 * id of ANOTHER server is unknown here (404: the lookup is scoped to the
 * URL's server, whose permissions were checked), and a server or request
 * id that is not a UUID is answered 404 before it reaches Postgres.
 *
 * The audit rows record the request id and its `source`, not the invite
 * code: the audit log is readable by moderators who may not see invite
 * codes (MANAGE_SERVER only, beta-review F7), and the request id leads to
 * the code for those who may.
 */
async function handlePost(
  req: Request,
  ctx: { params: Promise<{ id: string; requestId: string }> }
): Promise<NextResponse> {
  const { id: serverId, requestId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  const uid = session.session.uid;
  if (!isUuid(serverId)) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: 'Join request not found' }, { status: 404 });
  }

  let body: z.infer<typeof DecisionSchema>;
  try {
    body = DecisionSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const member = await requireServerMember(uid, serverId);
    if (!member.ok) return member.response;
    if (!canReviewJoinRequests(await getUserPermissions(getDb(), uid, serverId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (body.action === 'approve') {
      const result = await approveJoinRequest(getDb(), { serverId, requestId, decidedBy: uid });
      if (!result.ok) {
        if (result.error === 'not_found') {
          return NextResponse.json({ error: 'Join request not found' }, { status: 404 });
        }
        if (result.error === 'banned') {
          return NextResponse.json(
            { error: 'This user is banned from the server; the request was rejected', code: 'banned' },
            { status: 409 }
          );
        }
        return NextResponse.json(
          { error: 'This request was already decided', code: 'not_pending', status: result.request?.status ?? null },
          { status: 409 }
        );
      }
      void logAction(getDb(), {
        serverId,
        actorUserId: uid,
        action: 'member.join_approved',
        targetType: 'user',
        targetId: result.request.userId,
        metadata: {
          requestId: result.request.id,
          source: result.request.source,
          membershipId: result.membership.id,
        },
      }).catch((err) => console.error('[audit] member.join_approved failed:', (err as Error).message));
      // Bots milestone: a real join is greeted (never throws).
      if (result.created) {
        await notifyMemberJoined({ serverId, userId: result.request.userId });
      }
      return NextResponse.json({
        request: toDecisionJson(result.request),
        membership: { serverId, userId: result.request.userId },
      });
    }

    const result = await rejectJoinRequest(getDb(), { serverId, requestId, decidedBy: uid });
    if (!result.ok) {
      if (result.error === 'not_found') {
        return NextResponse.json({ error: 'Join request not found' }, { status: 404 });
      }
      return NextResponse.json(
        { error: 'This request was already decided', code: 'not_pending', status: result.request?.status ?? null },
        { status: 409 }
      );
    }
    void logAction(getDb(), {
      serverId,
      actorUserId: uid,
      action: 'member.join_rejected',
      targetType: 'user',
      targetId: result.request.userId,
      metadata: { requestId: result.request.id, source: result.request.source },
    }).catch((err) => console.error('[audit] member.join_rejected failed:', (err as Error).message));
    return NextResponse.json({ request: toDecisionJson(result.request) });
  } catch {
    return NextResponse.json({ error: 'Failed to decide the join request' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 1024,
  rateLimit: { identifier: 'server-join-requests-decide', config: { windowMs: 60_000, maxRequests: 30 } },
});
