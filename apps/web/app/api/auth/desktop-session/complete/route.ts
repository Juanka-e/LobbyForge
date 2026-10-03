import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getUserCredentialsById } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { getSessionSecret } from '@/lib/api-auth';
import {
  credentialMatches,
  isDesktopHandoffCodeShape,
  takeDesktopHandoffCode,
} from '@/lib/desktop-handoff-codes';
import { buildGuestSessionCookie, createGuestIdentity } from '@/lib/guest-session';
import { withApiSecurity } from '@/lib/security-headers';
import { recordSession } from '@/lib/session-tracker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Step 4 of the desktop session handoff (see ../route.ts): burn the
 * one-time code and issue the real session cookie. The desktop shell's
 * page calls this with the code the deep link delivered.
 */
const CompleteSchema = z.object({
  // security-review AUTH-001: only the alphabet the mint route produces,
  // so a "code" can never address another key under the handoff prefix
  // (such as the per-user index of outstanding codes).
  code: z.string().min(43).max(128).refine(isDesktopHandoffCodeShape),
  // LF-SEC-008: the state is REQUIRED and verified against the stored
  // value — a leaked/stolen code alone can no longer complete the
  // handoff.
  state: z.string().min(16).max(128),
});

/**
 * Constant-time string comparison. Hash-first so timingSafeEqual never
 * trips on length mismatches (the hash length is fixed).
 */
function safeEqualString(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

async function handlePost(req: Request): Promise<NextResponse> {
  const parsed = CompleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid handoff code.' }, { status: 400 });
  }

  // LF-SEC-008: GETDEL — the read and the delete are ONE atomic
  // operation, so two parallel complete requests can never both see the
  // record (the old GET→check→DEL had exactly that race). The code is
  // burned BEFORE anything else: a wrong state or a deleted account
  // does NOT resurrect it.
  const record = await takeDesktopHandoffCode(parsed.data.code);
  if (!record) {
    return NextResponse.json({ error: 'Handoff code expired or invalid.' }, { status: 401 });
  }

  // LF-SEC-008: state binding — constant-time compare against the
  // stored state. A code intercepted from the redirect URL carries the
  // state; an attacker who only stole the code fails here.
  if (!record.state || !safeEqualString(parsed.data.state, record.state)) {
    return NextResponse.json({ error: 'Handoff state mismatch.' }, { status: 401 });
  }

  const user = await getUserCredentialsById(getDb(), record.userId);
  if (!user || user.deletedAt) {
    // Code stays burned — the audit explicitly requires no resurrection.
    return NextResponse.json({ error: 'Account no longer available.' }, { status: 401 });
  }
  // security-review AUTH-001: the password the code was minted with must
  // still be the account's password. A change in between (the victim
  // locking out an attacker who knows the old one) voids the code, and
  // so does a record without a fingerprint or an account that no longer
  // has a password at all.
  if (!credentialMatches(record, user.passwordHash)) {
    return NextResponse.json({ error: 'Handoff code expired or invalid.' }, { status: 401 });
  }

  const sessionSeed = createGuestIdentity();
  const session = buildGuestSessionCookie(
    { gid: sessionSeed.gid, uid: user.id, name: user.displayName },
    getSessionSecret(),
    { secure: process.env.NODE_ENV === 'production' }
  );
  // beta-review (S7): record the session BEFORE handing out the cookie.
  // A password change revokes other sessions via `revokeOtherSessions`,
  // which can only revoke sessions it can list — the desktop handoff never recorded
  // its sessions, so an attacker signed in with a stolen password
  // survived the victim's password change. An unrecorded session could
  // never be revoked, so production fails closed (the same stance as the
  // revocation check in security-headers); dev/test only logs.
  try {
    await recordSession(user.id, sessionSeed.gid, req);
  } catch (error) {
    console.error('[auth/desktop-session] session tracking failed', (error as Error).message);
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'Sign-in is temporarily unavailable. Start the desktop sign-in again.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }
  }
  return NextResponse.json(
    { user: { id: user.id, displayName: user.displayName } },
    { headers: { 'Set-Cookie': session.setCookieHeader, 'Cache-Control': 'no-store' } }
  );
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 4096,
  rateLimit: { identifier: 'desktop-handoff-complete', config: { windowMs: 15 * 60_000, maxRequests: 15 } },
});
