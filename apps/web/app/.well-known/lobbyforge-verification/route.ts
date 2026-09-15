import { NextResponse } from 'next/server';
import { getDirectoryVerificationConfig } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /.well-known/lobbyforge-verification — serve this instance's
 * directory-registration verification document.
 *
 * The official registry fetches this endpoint server-side to verify
 * that the instance operator controls BOTH the domain AND the private
 * key matching the registered publicKey.
 *
 * The proof is Ed25519(privateKey, canonical payload {verify, instanceId,
 * domain, publicKey}) — the instance operator generates it during
 * lfctl directory setup and stores it alongside the keypair.
 */
async function handleGet(): Promise<NextResponse> {
  try {
    const config = await getDirectoryVerificationConfig(getDb());
    if (!config) {
      return NextResponse.json({ error: 'Instance not configured' }, { status: 404 });
    }
    if (!config.isPublicDirectoryEnabled) {
      return NextResponse.json(
        { error: 'Public directory is not enabled on this instance.' },
        { status: 404 }
      );
    }
    if (!config.domain || !config.publicKey) {
      return NextResponse.json(
        {
          error:
            'Directory verification not configured. Run: lfctl directory keygen, then set the domain and enable public directory in admin settings.',
        },
        { status: 404 }
      );
    }
    // 18th-audit: proof is persisted in the DB (migration 0035) via
    // the admin configure endpoint — no manual Redis writes needed.
    const proof = config.directoryProof;
    if (!proof) {
      return NextResponse.json(
        {
          error:
            'Directory proof not configured. Run lfctl directory proof, then POST to /api/admin/directory/config.',
        },
        { status: 404 }
      );
    }
    return NextResponse.json(
      {
        instanceId: config.instanceId,
        publicKey: config.publicKey,
        proof,
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
