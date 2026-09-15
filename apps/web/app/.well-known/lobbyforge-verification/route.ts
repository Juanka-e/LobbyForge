import { NextResponse } from 'next/server';
import { getInstanceSetupStatus } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /.well-known/lobbyforge-verification — serve this instance's
 * directory-registration verification document (16th-audit).
 *
 * The official registry fetches this endpoint server-side to verify
 * that the instance operator controls BOTH the domain AND the private
 * key matching the registered publicKey. Without this producer, a
 * vanilla self-host installation could never pass the registry's
 * domain-proof check.
 *
 * The keypair + proof are provisioned by `lfctl directory keygen` /
 * the admin "Enable Public Directory" flow and stored in
 * instance_settings.
 */
async function handleGet(): Promise<NextResponse> {
  try {
    const setup = await getInstanceSetupStatus(getDb());
    const doc = (setup as unknown as {
      directoryInstanceId?: string;
      directoryPublicKey?: string;
      directoryProof?: string;
    })();
    if (!doc?.directoryInstanceId || !doc?.directoryPublicKey || !doc?.directoryProof) {
      return NextResponse.json(
        { error: 'Directory verification not configured. Run lfctl directory keygen and enable public directory first.' },
        { status: 404 }
      );
    }
    return NextResponse.json(
      {
        instanceId: doc.directoryInstanceId,
        publicKey: doc.directoryPublicKey,
        proof: doc.directoryProof,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ error: 'Not available' }, { status: 500 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'well-known-verification', config: { windowMs: 60_000, maxRequests: 30 } },
});
