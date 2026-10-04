import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getUserCredentialsByEmail } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { verifyPassword, DUMMY_PASSWORD_HASH } from '@/lib/password';
import {
  DESKTOP_HANDOFF_TTL_SECONDS,
  credentialFingerprint,
  storeDesktopHandoffCode,
} from '@/lib/desktop-handoff-codes';
import {
  accountLockedResponse,
  beginSignInAttempt,
  confirmSignInDevice,
  finishSignInAttempt,
} from '@/lib/auth-throttle';
import { buildDeviceCookie, deviceClaimHolds, readDeviceClaim } from '@/lib/device-cookie';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * DP-07 — desktop session handoff (the missing producer of the flow the
 * TS parser already validates: lobbyforge://session/complete?code&state).
 *
 * Flow:
 *  1. POST /api/auth/desktop-session { email, password }
 *     → validates credentials, stores a ONE-TIME code in Redis (5 min
 *       TTL, single use), returns { code, state, redirectUrl }.
 *  2. The desktop shell opens redirectUrl in the system browser (the
 *     instance login page is NOT in the shell — this endpoint is what a
 *     "Login on this instance" button in the shell calls via the web).
 *  3. The browser lands on lobbyforge://session/complete?...; the OS
 *     routes it to the shell (deep-link handler forwards it into the
 *     page).
 *  4. POST /api/auth/desktop-session/complete { code, state }
 *     → burns the code, issues the real session cookie.
 */

const StartSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
  /** Where the shell wants the handoff to land (info only, echoed back). */
  state: z.string().min(32).max(128).optional(),
});

const CODE_TTL_SECONDS = DESKTOP_HANDOFF_TTL_SECONDS;

async function handleStart(req: Request): Promise<NextResponse> {
  const parsed = StartSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 400 });
  }

  // Security follow-up: the SAME per-account failure counter as
  // /api/auth/login, so the two sign-in doors do not add up to double the
  // guesses. Counted for unknown emails too; locked → generic 429. The
  // same device cookies apply: a browser that signed in to this account
  // before has its own bucket and is not refused by the account lock.
  const cookieHeader = req.headers.get('cookie');
  const device = readDeviceClaim(cookieHeader, parsed.data.email);
  const subject = { email: parsed.data.email, deviceNonce: device?.nonce ?? null };
  const begun = await beginSignInAttempt(subject);
  if (!begun.allowed) return accountLockedResponse(begun.retryAfterSeconds);

  const user = await getUserCredentialsByEmail(getDb(), parsed.data.email);
  // As /api/auth/login: a device entry issued under an older password is
  // charged to the account counter (before the password check), and the
  // binding is computed for every attempt, unknown emails included.
  const attempt = await confirmSignInDevice(
    subject,
    begun,
    deviceClaimHolds(device, parsed.data.email, user && !user.deletedAt ? user.passwordHash : null)
  );
  if (!attempt.allowed) return accountLockedResponse(attempt.retryAfterSeconds);

  const valid = await verifyPassword(parsed.data.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || user.deletedAt || !user.passwordHash || !valid) {
    // Same timing-safe shape as /api/auth/login; no account enumeration.
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
  }
  await finishSignInAttempt(subject, attempt.path);

  // One-time code + state (the TS parser requires 43-128 urlsafe chars).
  const code = randomBytes(32).toString('base64url');
  const state = parsed.data.state ?? randomBytes(24).toString('base64url');

  // security-review AUTH-001: bind the code to the credential it was
  // minted under (and index it per user) so a password change kills it.
  await storeDesktopHandoffCode(code, {
    userId: user.id,
    state,
    used: false,
    credential: credentialFingerprint(user.passwordHash),
  });

  const headers = new Headers({ 'Cache-Control': 'no-store' });
  // As /api/auth/login: a successful start earns this browser a device
  // cookie for the account, bound to the current password hash.
  const deviceCookie = buildDeviceCookie(cookieHeader, parsed.data.email, user.passwordHash);
  if (deviceCookie) headers.append('Set-Cookie', deviceCookie);
  return NextResponse.json(
    {
      code,
      state,
      expiresIn: CODE_TTL_SECONDS,
      redirectUrl: `lobbyforge://session/complete?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}&instance=${encodeURIComponent(process.env.NEXT_PUBLIC_BASE_URL ?? '')}`,
    },
    { headers }
  );
}

export const POST = withApiSecurity(handleStart, {
  allowedMethods: ['POST'],
  maxBodyBytes: 4096,
  rateLimit: { identifier: 'desktop-handoff-start', config: { windowMs: 15 * 60_000, maxRequests: 10 } },
});
