import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { redis } from '@/lib/redis';
import { requireMaterializedSession } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/directory/register/challenge?instanceId=…&domain=… — issue the
 * 15th-audit ACCOUNT-BOUND registration challenge.
 *
 * The old proof was replayable: the .well-known document is public, so
 * an attacker who saw it could submit the same instanceId+domain+
 * publicKey tuple and become the "first registrant" before the real
 * operator. The challenge now binds to the CALLING REGISTRY ACCOUNT:
 * the instance must sign {register, nonce, instanceId, domain} with
 * the private key matching the publicKey, and the nonce is stored
 * against (userId, instanceId, domain) — only THAT user's submission
 * can consume it.
 */
const CHALLENGE_TTL_SECONDS = 600;

async function handleGet(req: Request): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;

  const url = new URL(req.url);
  const instanceId = url.searchParams.get('instanceId') ?? '';
  const domain = url.searchParams.get('domain') ?? '';
  if (!instanceId || instanceId.length < 3 || instanceId.length > 128) {
    return NextResponse.json({ error: 'instanceId query parameter is required' }, { status: 400 });
  }
  if (!domain || domain.length < 3 || domain.length > 253) {
    return NextResponse.json({ error: 'domain query parameter is required' }, { status: 400 });
  }

  // One challenge per (user, instanceId, domain) — re-request returns
  // the SAME value (no churn), stored with TTL, single-use on submit.
  const key = `lf:reg-challenge:${sessionResult.session.uid}:${instanceId}:${domain}`;
  const existing = await redis.get(key);
  if (existing) {
    return NextResponse.json(
      { challenge: existing, expiresIn: CHALLENGE_TTL_SECONDS },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }
  const challenge = randomBytes(24).toString('base64url');
  await redis.set(key, challenge, 'EX', CHALLENGE_TTL_SECONDS);
  return NextResponse.json(
    { challenge, expiresIn: CHALLENGE_TTL_SECONDS },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'directory-register-challenge', config: { windowMs: 60_000, maxRequests: 5 } },
});
