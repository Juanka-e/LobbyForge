import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { redis } from '@/lib/redis';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/directory/register/challenge?instanceId=… — issue the
 * registration ownership challenge (11th-audit). The instance
 * operator's keypair proves control: sign the returned challenge with
 * the PRIVATE key matching the publicKey being registered, and submit
 * both with the registration. Challenges are one-time (GETDEL on
 * use) and expire in 10 minutes.
 */
const CHALLENGE_TTL_SECONDS = 600;

async function handleGet(req: Request): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;

  const instanceId = new URL(req.url).searchParams.get('instanceId');
  if (!instanceId || instanceId.length < 3 || instanceId.length > 128) {
    return NextResponse.json({ error: 'instanceId query parameter is required' }, { status: 400 });
  }

  const challenge = randomBytes(24).toString('base64url');
  const key = `lf:register-challenge:${instanceId}`;
  const stored = await redis.set(key, challenge, 'EX', CHALLENGE_TTL_SECONDS, 'NX');
  if (stored !== 'OK') {
    // An unanswered challenge exists — return it (same TTL) instead of
    // letting a caller churn challenges; the value stays single-use.
    const existing = await redis.get(key);
    if (existing) {
      return NextResponse.json(
        { challenge: existing, expiresIn: CHALLENGE_TTL_SECONDS },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }
  }
  return NextResponse.json(
    { challenge, expiresIn: CHALLENGE_TTL_SECONDS },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'directory-register-challenge', config: { windowMs: 60_000, maxRequests: 5 } },
});
