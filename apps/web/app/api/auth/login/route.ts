import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserCredentialsByEmail } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { buildGuestSessionCookie, createGuestIdentity } from '@/lib/guest-session';
import { getSessionSecret } from '@/lib/api-auth';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '@/lib/password';
import { withApiSecurity } from '@/lib/security-headers';
import { recordSession } from '@/lib/session-tracker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});

async function handlePost(req: Request): Promise<NextResponse> {
  const parsed = LoginSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 400 });
  }

  const user = await getUserCredentialsByEmail(getDb(), parsed.data.email);
  const valid = await verifyPassword(parsed.data.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || user.deletedAt || !user.passwordHash || !valid) {
    console.warn(`[security] failed login: email=${parsed.data.email.slice(0, 3)}*** ip=${req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'}`);
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
  }

  const sessionSeed = createGuestIdentity();
  const session = buildGuestSessionCookie(
    { gid: sessionSeed.gid, uid: user.id, name: user.displayName },
    getSessionSecret(),
    { secure: process.env.NODE_ENV === 'production' }
  );
  // beta-review (S7): record the session BEFORE handing out the cookie.
  // A password change revokes other sessions via `revokeOtherSessions`,
  // which can only revoke sessions it can list — login never recorded
  // its sessions, so an attacker signed in with a stolen password
  // survived the victim's password change. An unrecorded session could
  // never be revoked, so production fails closed (the same stance as the
  // revocation check in security-headers); dev/test only logs.
  try {
    await recordSession(user.id, sessionSeed.gid, req);
  } catch (error) {
    console.error('[auth/login] session tracking failed', (error as Error).message);
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'Sign-in is temporarily unavailable. Try again shortly.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }
  }
  return NextResponse.json(
    { user: { id: user.id, email: user.email, displayName: user.displayName } },
    { headers: { 'Set-Cookie': session.setCookieHeader, 'Cache-Control': 'no-store' } }
  );
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  sessionRevocation: 'bypass',
  rateLimit: { identifier: 'auth-local-login', config: { windowMs: 15 * 60_000, maxRequests: 10 } },
});
