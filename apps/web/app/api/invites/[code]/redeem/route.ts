import { NextResponse } from 'next/server';
import { z } from 'zod';
import { JOIN_REQUEST_NOTE_MAX_LENGTH, logAction, redeemInvite } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { normalizeInviteCode } from '@/lib/invite-code';
import { withApiSecurity } from '@/lib/security-headers';
import { notifyMemberJoined } from '@/lib/bots/welcome';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
  const secret = getSessionSecret();
  const session = readGuestSession(req.headers.get('cookie'), secret);
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }
  if (!session.uid) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Guest user has no materialized user record', howToFix: 'Re-issue POST /api/auth/guest' },
        { status: 503 }
      ),
    };
  }
  return { ok: true, uid: session.uid };
}

/**
 * Optional body: a note for the moderators, used only when the server holds
 * newcomers for approval (the join request carries it). An empty body is
 * the plain redeem.
 */
const RedeemBodySchema = z
  .object({ note: z.string().max(JOIN_REQUEST_NOTE_MAX_LENGTH).optional() })
  .strict();

async function readNote(req: Request): Promise<{ ok: true; note: string | null } | { ok: false }> {
  const raw = await req.text().catch(() => '');
  if (!raw.trim()) return { ok: true, note: null };
  try {
    const parsed = RedeemBodySchema.safeParse(JSON.parse(raw));
    return parsed.success ? { ok: true, note: parsed.data.note ?? null } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function handlePost(req: Request, ctx: { params: Promise<{ code: string }> }): Promise<NextResponse> {
  const { code: rawCode } = await ctx.params;
  const session = await resolveSession(req);
  if (!session.ok) return session.response;

  try {
    const code = normalizeInviteCode(rawCode ?? '');
    if (!code) {
      return NextResponse.json({ error: 'Invalid invite code' }, { status: 400 });
    }
    const body = await readNote(req);
    if (!body.ok) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const result = await redeemInvite(getDb(), code, session.uid, { note: body.note });
    if (result.ok) {
      void logAction(getDb(), {
        serverId: result.serverId,
        actorUserId: session.uid,
        action: 'invite.redeem',
        targetType: 'membership',
        targetId: result.membershipId,
        metadata: { code, roleId: result.roleId },
      }).catch((err) => console.error('[audit] invite.redeem failed:', (err as Error).message));
      // Bots milestone: the Welcome Bot greets the new member (never throws).
      await notifyMemberJoined({ serverId: result.serverId, userId: session.uid });
      return NextResponse.json(
        {
          membership: {
            serverId: result.serverId,
            userId: session.uid,
            roleId: result.roleId,
            roleIds: [result.roleId],
          },
        },
        { status: 201 }
      );
    }
    // Map the discriminated error to a status code.
    switch (result.error) {
      case 'not_found':
      case 'expired':
      case 'exhausted':
        return NextResponse.json({ error: 'Invite is unavailable' }, { status: 403 });
      case 'already_member':
        return NextResponse.json({ error: 'You are already a member of this server' }, { status: 409 });
      case 'no_everyone_role':
        return NextResponse.json(
          { error: 'Server is missing the @everyone role. This is a server-side bug.' },
          { status: 500 }
        );
      case 'banned':
        return NextResponse.json(
          { error: 'You are banned from this server' },
          { status: 403 }
        );
      // security-review AUTHZ-004 follow-up: the server's access policy
      // holds newcomers for approval — a join request waits for a
      // moderator instead of a membership (no join hook, no audit row: no
      // one joined). The request consumed one use of the invite.
      case 'pending_approval':
        return NextResponse.json(
          {
            status: 'pending_approval',
            request: {
              id: result.request.id,
              serverId: result.serverId,
              createdAt: result.request.createdAt.toISOString(),
            },
          },
          { status: 202, headers: { 'Cache-Control': 'no-store' } }
        );
      case 'join_rejected':
        return NextResponse.json(
          {
            error: 'A moderator declined your request to join this server',
            code: 'join_rejected',
            retryAfter: result.retryAfter.toISOString(),
          },
          { status: 403 }
        );
      case 'join_request_limit':
        return NextResponse.json(
          { error: 'Too many requests to join this server today', code: 'join_request_limit' },
          { status: 429 }
        );
    }
  } catch (err) {
    // The 500 used to be silent, which hid a redeem bug for every invite
    // with an expiry. Logged without the invite code or the user id.
    console.error('[invites/redeem] redeem failed:', describeRedeemError(err));
    return NextResponse.json(
      { error: 'Failed to redeem invite' },
      { status: 500 }
    );
  }
}

/**
 * One JSON-quoted log line for an unexpected redeem failure (JSON keeps a
 * hostile value from forging log lines). A Drizzle query error embeds the
 * query and its parameters — the invite code among them — in its own
 * message, so the driver error it wraps is described instead.
 */
function describeRedeemError(err: unknown): string {
  const source = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  if (!(source instanceof Error)) return JSON.stringify({ error: typeof source });
  const code = (source as { code?: unknown }).code;
  return JSON.stringify({
    error: source.name,
    ...(typeof code === 'string' ? { code } : {}),
    message: source.message,
  });
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  // `{ note }` (≤ 500 characters) for an approval-held join; 4 KiB is ample.
  maxBodyBytes: 4 * 1024,
  rateLimit: { identifier: 'invite-redeem', config: { windowMs: 60_000, maxRequests: 10 } },
});
