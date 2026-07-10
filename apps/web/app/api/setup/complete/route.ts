import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  completeInitialBootstrap,
  getInstanceBootstrapStatus,
  SetupAlreadyCompleteError,
  type InstanceSetupStatus,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { completeSetupSchema } from '@/lib/validators/setup';
import { hashPassword } from '@/lib/password';
import { buildGuestSessionCookie, createGuestIdentity } from '@/lib/guest-session';
import { getSessionSecret } from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SuccessResponse {
  status: 'completed';
  setup: InstanceSetupStatus;
  serverId: string;
}

async function handlePost(request: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const parsed = completeSetupSchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid setup payload.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const input = parsed.data;

  const expectedSetupToken = process.env.LOBBYFORGE_SETUP_TOKEN;
  if (process.env.NODE_ENV === 'production' && !expectedSetupToken) {
    return NextResponse.json({ error: 'Setup token is not configured on this instance.' }, { status: 503 });
  }
  if (expectedSetupToken && !matchesSetupToken(input.setupToken, expectedSetupToken)) {
    return NextResponse.json({ error: 'Invalid setup token.' }, { status: 403 });
  }

  try {
    const current = await getInstanceBootstrapStatus(getDb());
    if (current.bootstrapComplete) {
      return NextResponse.json({ error: 'Setup is already complete.' }, { status: 409 });
    }
    const ownerPasswordHash = await hashPassword(input.ownerPassword);
    const result = await completeInitialBootstrap(getDb(), {
      instanceName: input.instanceName,
      ownerDisplayName: input.ownerDisplayName,
      ownerEmail: input.ownerEmail,
      ownerPasswordHash,
      registrationMode: input.registrationMode,
      guestAccessEnabled: input.guestAccessEnabled,
      seoIndexingEnabled: input.seoIndexingEnabled,
      seoTitle: input.seoTitle ?? null,
      seoDescription: input.seoDescription ?? null,
    });
    const sessionSeed = createGuestIdentity();
    const session = buildGuestSessionCookie(
      { gid: sessionSeed.gid, uid: result.owner.id, name: result.owner.displayName },
      getSessionSecret(),
      { secure: process.env.NODE_ENV === 'production' }
    );
    const body: SuccessResponse = { status: 'completed', setup: result.setup, serverId: result.server.id };
    return NextResponse.json(body, {
      status: 200,
      headers: { 'Set-Cookie': session.setCookieHeader, 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    if (err instanceof SetupAlreadyCompleteError) {
      return NextResponse.json({ error: 'Setup is already complete.' }, { status: 409 });
    }
    console.error('[setup/complete] bootstrap failed:', (err as Error).name || 'UnknownError');
    return NextResponse.json(
      { error: 'Setup could not be completed. Check the owner email and try again.' },
      { status: 500 }
    );
  }
}

function matchesSetupToken(candidate: string | undefined, expected: string): boolean {
  const candidateHash = createHash('sha256').update(candidate ?? '').digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'setup-complete', config: { windowMs: 15 * 60_000, maxRequests: 10 } },
});
