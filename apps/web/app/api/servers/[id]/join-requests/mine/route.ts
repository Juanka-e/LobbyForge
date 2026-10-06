import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  cancelJoinRequest,
  getOpenJoinRequest,
  getServerById,
  JOIN_REQUEST_NOTE_MAX_LENGTH,
  joinRequestRetryAfter,
  requestToJoinServer,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { isUuid } from '@/lib/join-requests';
import { resolveAutoJoinServerId } from '@/lib/lobby-auto-join';
import { withApiSecurity } from '@/lib/security-headers';
import { requireVerifiedEmail } from '@/lib/mail/verification';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The caller's own join request to a server — no membership needed (the
 * caller is, by definition, not a member yet), and only ever their own row.
 *
 * GET: `{ request: null | { id, status: 'pending' | 'rejected', createdAt,
 * decidedAt, retryAfter } }` — the request that still decides what the join
 * page shows (pending, or a moderator's rejection in its cooldown). The
 * note and the moderator's identity are not echoed.
 * POST `{ note? }`: the lobby's "Ask to join" — file an `auto_join` request
 * (see handlePost).
 * DELETE: withdraw the pending request → `{ cancelled: boolean }`.
 *
 * A server id that is not a UUID is answered 404 before it reaches Postgres.
 */
async function handleGet(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  if (!isUuid(serverId)) return serverNotFound();
  try {
    if (!(await getServerById(getDb(), serverId))) return serverNotFound();
    const open = await getOpenJoinRequest(getDb(), serverId, session.session.uid);
    return NextResponse.json(
      {
        request: open
          ? {
              id: open.id,
              status: open.status,
              createdAt: open.createdAt.toISOString(),
              decidedAt: open.decidedAt ? open.decidedAt.toISOString() : null,
              retryAfter: open.status === 'rejected' ? joinRequestRetryAfter(open).toISOString() : null,
            }
          : null,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ error: 'Failed to read the join request' }, { status: 500 });
  }
}

/** Optional body: a note for the moderators. An empty body asks without one. */
const AskBodySchema = z.object({ note: z.string().max(JOIN_REQUEST_NOTE_MAX_LENGTH).optional() }).strict();

async function readNote(req: Request): Promise<{ ok: true; note: string | null } | { ok: false }> {
  const raw = await req.text().catch(() => '');
  if (!raw.trim()) return { ok: true, note: null };
  try {
    const parsed = AskBodySchema.safeParse(JSON.parse(raw));
    return parsed.success ? { ok: true, note: parsed.data.note ?? null } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * POST — the lobby's "Ask to join". The lobby page itself never files a
 * request (a GET, possibly a cross-site top-level link, must not put anyone
 * in the queue); this explicit, same-origin POST does. Without an invite,
 * only the community the lobby auto-join serves can be asked
 * (`resolveAutoJoinServerId`: the instance's first community, for a user
 * who could have registered into it) — any other server answers 403
 * `invite_required`. The rules and limits are an invite-filed request's
 * (`requestToJoinServer`), with source `auto_join` and no invite use:
 *   202 pending_approval (filed, or the pending one returned)
 *   403 banned / join_rejected (+ retryAfter) / invite_required
 *   409 already_member / approval_not_required (the lobby joins on load)
 *   429 join_request_limit
 */
async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  const uid = session.session.uid;
  if (!isUuid(serverId)) return serverNotFound();
  const body = await readNote(req);
  if (!body.ok) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  // docs/EMAIL.md §4.2: the note is free text sent to the moderators — an
  // unverified account in `required` mode may ask to join, not write one.
  if (body.note?.trim()) {
    const unverified = await requireVerifiedEmail(uid, 'join_request');
    if (unverified) return unverified;
  }
  try {
    const db = getDb();
    if (!(await getServerById(db, serverId))) return serverNotFound();
    if ((await resolveAutoJoinServerId(db, uid)) !== serverId) {
      return NextResponse.json(
        { error: 'This community takes new members through an invite', code: 'invite_required' },
        { status: 403 }
      );
    }
    const outcome = await requestToJoinServer(db, { serverId, userId: uid, note: body.note });
    switch (outcome.kind) {
      case 'pending':
        return NextResponse.json(
          {
            status: 'pending_approval',
            request: { id: outcome.request.id, serverId, createdAt: outcome.request.createdAt.toISOString() },
          },
          { status: 202, headers: { 'Cache-Control': 'no-store' } }
        );
      case 'banned':
        return NextResponse.json({ error: 'You are banned from this server', code: 'banned' }, { status: 403 });
      case 'rejected':
        return NextResponse.json(
          {
            error: 'A moderator declined your request to join this server',
            code: 'join_rejected',
            retryAfter: outcome.retryAfter.toISOString(),
          },
          { status: 403 }
        );
      case 'limited':
        return NextResponse.json(
          { error: 'Too many requests to join this server today', code: 'join_request_limit' },
          { status: 429 }
        );
      case 'already_member':
        return NextResponse.json(
          { error: 'You are already a member of this server', code: 'already_member' },
          { status: 409 }
        );
      case 'approval_not_required':
        return NextResponse.json(
          { error: 'This community admits new members without approval', code: 'approval_not_required' },
          { status: 409 }
        );
    }
  } catch {
    return NextResponse.json({ error: 'Failed to send the join request' }, { status: 500 });
  }
}

async function handleDelete(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: serverId } = await ctx.params;
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  if (!isUuid(serverId)) return serverNotFound();
  try {
    if (!(await getServerById(getDb(), serverId))) return serverNotFound();
    const cancelled = await cancelJoinRequest(getDb(), serverId, session.session.uid);
    return NextResponse.json({ cancelled: cancelled !== null });
  } catch {
    return NextResponse.json({ error: 'Failed to cancel the join request' }, { status: 500 });
  }
}

function serverNotFound(): NextResponse {
  return NextResponse.json({ error: 'Server not found' }, { status: 404 });
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'server-join-request-mine', config: { windowMs: 60_000, maxRequests: 60 } },
});

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  // `{ note }` (≤ 500 characters); 4 KiB is ample — same as the invite redeem.
  maxBodyBytes: 4 * 1024,
  // Same budget as POST /api/invites/{code}/redeem, the other way to file one.
  rateLimit: { identifier: 'server-join-request-ask', config: { windowMs: 60_000, maxRequests: 10 } },
});

export const DELETE = withApiSecurity(handleDelete, {
  allowedMethods: ['DELETE'],
  maxBodyBytes: 0,
  rateLimit: { identifier: 'server-join-request-cancel', config: { windowMs: 60_000, maxRequests: 10 } },
});
