import { NextResponse } from 'next/server';
import { clearCookieHeader } from '@lobbyforge/core';
import { getSessionSecret } from '@/lib/api-auth';
import { readGuestSession } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { revokeSession } from '@/lib/session-tracker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handlePost(req: Request): Promise<NextResponse> {
  const session = readGuestSession(req.headers.get('cookie'), getSessionSecret());
  if (session?.uid) {
    await revokeSession(session.uid, session.gid).catch((error) => {
      console.error('[auth/logout] session revocation failed', (error as Error).message);
    });
  }
  return NextResponse.json(
    { status: 'signed_out' },
    { headers: { 'Set-Cookie': clearCookieHeader('lf_guest'), 'Cache-Control': 'no-store' } }
  );
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  sessionRevocation: 'bypass',
  maxBodyBytes: 0,
  rateLimit: { identifier: 'auth-logout', config: { windowMs: 60_000, maxRequests: 20 } },
});
