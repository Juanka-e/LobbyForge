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
    // The proof must be provided by the operator (lfctl generates it
    // with the private key and stores it). We read it from the
    // privateKeyEncrypted column's companion metadata or the operator
    // sets it via the admin settings API. For now, we compute it from
    // the stored private key if available; otherwise return setup
    // instructions.
    const { getDirectoryProof } = await import('@/lib/directory-proof');
    const proof = await getDirectoryProof(config.instanceId, config.domain, config.publicKey);
    if (!proof) {
      return NextResponse.json(
        {
          error:
            'Directory proof not generated. Run: lfctl directory proof --instance-id <id> --domain <domain> --key-file <private-key.pem>',
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
