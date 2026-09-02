import { NextResponse } from 'next/server';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getUserCredentialsByEmail, getUserById } from '@lobbyforge/db';
import { redis } from '@/lib/redis';
import { getDb } from '@/lib/db';
import { verifyPassword, DUMMY_PASSWORD_HASH } from '@/lib/password';
import { getSessionSecret } from '@/lib/api-auth';
import { buildGuestSessionCookie, createGuestIdentity } from '@/lib/guest-session';
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

const CODE_TTL_SECONDS = 300;

function redisKey(code: string): string {
  return `lf:desktop-handoff:${code}`;
}

async function handleStart(req: Request): Promise<NextResponse> {
  const parsed = StartSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 400 });
  }

  const user = await getUserCredentialsByEmail(getDb(), parsed.data.email);
  const valid = await verifyPassword(parsed.data.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || user.deletedAt || !user.passwordHash || !valid) {
    // Same timing-safe shape as /api/auth/login; no account enumeration.
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
  }

  // One-time code + state (the TS parser requires 43-128 urlsafe chars).
  const code = randomBytes(32).toString('base64url');
  const state = parsed.data.state ?? randomBytes(24).toString('base64url');

  await redis.set(
    redisKey(code),
    JSON.stringify({ userId: user.id, state, used: false }),
    'EX',
    CODE_TTL_SECONDS
  );

  return NextResponse.json(
    {
      code,
      state,
      expiresIn: CODE_TTL_SECONDS,
      redirectUrl: `lobbyforge://session/complete?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const POST = withApiSecurity(handleStart, {
  allowedMethods: ['POST'],
  maxBodyBytes: 4096,
  rateLimit: { identifier: 'desktop-handoff-start', config: { windowMs: 15 * 60_000, maxRequests: 10 } },
});
