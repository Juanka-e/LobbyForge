import { NextResponse } from 'next/server';
import { isUsernameAvailable } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';
import { normalizeUsername, usernameProblem } from '@/lib/profile-fields';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/users/me/username?name=… — may the signed-in account take this
 * handle? The settings page asks while the user types (docs/PROFILES.md
 * "Profile fields"). Advisory only: the PATCH and the unique constraint
 * decide. Handles are shown to every fellow member anyway, so "taken" tells
 * nobody anything new; the rate limit keeps it from being a bulk lookup.
 */
async function handleGet(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  const raw = new URL(req.url).searchParams.get('name') ?? '';
  const username = normalizeUsername(raw.slice(0, 64));
  const headers = { 'Cache-Control': 'no-store' };
  const problem = usernameProblem(username);
  if (problem) return NextResponse.json({ username, available: false, problem }, { headers });
  const available = await isUsernameAvailable(getDb(), username, session.session.uid);
  return NextResponse.json({ username, available, problem: available ? null : 'taken' }, { headers });
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'username-availability', config: { windowMs: 60_000, maxRequests: 60 } },
});
