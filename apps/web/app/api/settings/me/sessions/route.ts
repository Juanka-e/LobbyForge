import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';
import { listSessions, revokeSession } from '@/lib/session-tracker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RevokeSessionSchema = z
  .object({
    action: z.literal('revoke'),
    gid: z.string().min(8).max(256),
  })
  .strict();

/**
 * GET /api/settings/me/sessions
 *   -> { sessions: SessionFingerprint[] }
 *
 * PATCH /api/settings/me/sessions { action: 'revoke', gid: string }
 *   -> { success: true }
 *
 * Auth: materialized guest session (the uid in the cookie). Each user
 * can only see/revoke their own sessions.
 */

async function handleGet(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  const sessions = await listSessions(session.session.uid);
  return NextResponse.json({ sessions }, { headers: { 'Cache-Control': 'no-store' } });
}

async function handlePatch(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;

  let body: z.infer<typeof RevokeSessionSchema>;
  try {
    body = RevokeSessionSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Expected {action: "revoke", gid: string}.' }, { status: 400 });
  }

  // Prevent self-revoke of the current session through this endpoint -
  // the user should use /api/auth/logout for that, which also clears
  // the cookie. Revoking the current gid here would leave a dangling
  // cookie that still authenticates until the next page load.
  if (body.gid === session.session.gid) {
    return NextResponse.json(
      { error: 'Use sign out to end the current session.' },
      { status: 409 }
    );
  }

  await revokeSession(session.session.uid, body.gid);
  return NextResponse.json({ success: true });
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'sessions-list', config: { windowMs: 60_000, maxRequests: 20 } },
});

export const PATCH = withApiSecurity(handlePatch, {
  allowedMethods: ['PATCH'],
  rateLimit: { identifier: 'sessions-revoke', config: { windowMs: 60_000, maxRequests: 10 } },
});

