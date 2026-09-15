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
  const rawDomain = url.searchParams.get('domain') ?? '';
  if (!instanceId || instanceId.length < 3 || instanceId.length > 128) {
    return NextResponse.json({ error: 'instanceId query parameter is required' }, { status: 400 });
  }
  if (!rawDomain || rawDomain.length < 3 || rawDomain.length > 253) {
    return NextResponse.json({ error: 'domain query parameter is required' }, { status: 400 });
  }

  // 16th-audit: NORMALIZE the domain the same way register does —
  // the old code stored the raw value (trailing-slash variants
  // produced different Redis keys than the normalized lookup).
  let domain: string;
  try {
    const { normalizeRegistryInstanceUrl } = await import('@lobbyforge/registry');
    domain = normalizeRegistryInstanceUrl(rawDomain);
  } catch {
    return NextResponse.json({ error: 'domain must be a valid HTTPS origin' }, { status: 400 });
  }

  // 16th-audit: atomic create-if-absent (SET NX) — the old GET→SET
  // race could invalidate a challenge the instant it was returned.
  const key = `lf:reg-challenge:${sessionResult.session.uid}:${instanceId}:${domain}`;
  const challenge = randomBytes(24).toString('base64url');
  const stored = await redis.set(key, challenge, 'EX', CHALLENGE_TTL_SECONDS, 'NX');
  if (stored === 'OK') {
    return NextResponse.json(
      { challenge, domain, expiresIn: CHALLENGE_TTL_SECONDS },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }
  // NX lost — an active challenge already exists; return it.
  const existing = await redis.get(key);
  return NextResponse.json(
    { challenge: existing ?? challenge, domain, expiresIn: CHALLENGE_TTL_SECONDS },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'directory-register-challenge', config: { windowMs: 60_000, maxRequests: 5 } },
});
