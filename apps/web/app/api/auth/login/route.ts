import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserCredentialsByEmail } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { buildGuestSessionCookie, createGuestIdentity } from '@/lib/guest-session';
import { getSessionSecret } from '@/lib/api-auth';
import {
  accountLockedResponse,
  beginSignInAttempt,
  confirmSignInDevice,
  finishSignInAttempt,
} from '@/lib/auth-throttle';
import { guardSignInCaptcha, noteSignInFailure } from '@/lib/captcha/guard';
import { CaptchaBodyFields } from '@/lib/captcha/types';
import { buildDeviceCookie, deviceClaimHolds, readDeviceClaim, trustedDeviceFor } from '@/lib/device-cookie';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '@/lib/password';
import { resolveClientAddress, withApiSecurity } from '@/lib/security-headers';
import { recordSession } from '@/lib/session-tracker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
  // Bot protection (docs/CAPTCHA.md §4.3): asked for adaptively.
  ...CaptchaBodyFields,
});

async function handlePost(req: Request): Promise<NextResponse> {
  const parsed = LoginSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 400 });
  }

  // Security follow-up: a per-ACCOUNT failure limit shared with the
  // desktop handoff start (the per-IP bucket alone let a distributed
  // attacker guess forever). Counted before anything is looked up, for
  // known and unknown emails alike; a locked account gets the generic 429
  // whether or not the password is right. A browser holding a valid
  // device cookie for this email (it signed in here before) is counted in
  // its own bucket instead, so a lockout aimed at the address does not
  // lock the owner out of their own devices.
  const cookieHeader = req.headers.get('cookie');
  const device = readDeviceClaim(cookieHeader, parsed.data.email);

  // Bot protection — adaptive sign-in (docs/CAPTCHA.md §2): the challenge
  // is asked for after repeated failures on this account or address, in
  // attack mode, or always (by setting) — never from a TRUSTED device for
  // this account. Checked BEFORE the attempt is counted, so a request
  // refused here costs the account nothing.
  const trusted = await trustedDeviceFor(parsed.data.email, device);
  const refused = await guardSignInCaptcha(req, parsed.data, { email: parsed.data.email, hasDeviceClaim: trusted.trusted });
  if (refused) return refused;

  const subject = { email: parsed.data.email, deviceNonce: device?.nonce ?? null };
  const begun = await beginSignInAttempt(subject);
  if (!begun.allowed) return accountLockedResponse(begun.retryAfterSeconds);

  const user = trusted.lookedUp ? trusted.user : await getUserCredentialsByEmail(getDb(), parsed.data.email);
  // A device cookie entry is bound to the password it was issued under: once
  // the password has changed, it no longer earns a bucket of its own and the
  // attempt is charged to the account counter, still before the password is
  // checked. Computed for every attempt (a stand-in when there is no
  // account), so unknown emails do the same work.
  const attempt = await confirmSignInDevice(
    subject,
    begun,
    deviceClaimHolds(device, parsed.data.email, user && !user.deletedAt ? user.passwordHash : null)
  );
  if (!attempt.allowed) return accountLockedResponse(attempt.retryAfterSeconds);

  const valid = await verifyPassword(parsed.data.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || user.deletedAt || !user.passwordHash || !valid) {
    // The address the rate limiter trusts (the LAST hop the trusted proxy
    // saw — SEC-004), not the first X-Forwarded-For entry, which the client
    // writes itself and could use to forge log lines.
    console.warn(`[security] failed login: email=${parsed.data.email.slice(0, 3)}*** ip=${JSON.stringify(resolveClientAddress(req))}`);
    // Feeds the address signal and attack mode of adaptive sign-in.
    await noteSignInFailure(req);
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
  }
  await finishSignInAttempt(subject, attempt.path);

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
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', session.setCookieHeader);
  // Only a successful sign-in earns this browser a device cookie for the
  // account — an unknown email never gets one. The entry is bound to the
  // current password hash and replaces any stale entry for this email.
  const deviceCookie = buildDeviceCookie(cookieHeader, parsed.data.email, user.passwordHash);
  if (deviceCookie) headers.append('Set-Cookie', deviceCookie);
  return NextResponse.json({ user: { id: user.id, email: user.email, displayName: user.displayName } }, { headers });
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  sessionRevocation: 'bypass',
  // Room for a CAPTCHA token (up to 4096 characters).
  maxBodyBytes: 12 * 1024,
  rateLimit: { identifier: 'auth-local-login', config: { windowMs: 15 * 60_000, maxRequests: 10 } },
});
