import { NextResponse } from 'next/server';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { z } from 'zod';
import { RegistryInstanceOwnedError, RegistryInstanceUnclaimableError, upsertRegistryInstance } from '@lobbyforge/db';
import { normalizeRegistryInstanceUrl } from '@lobbyforge/registry';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RegisterSchema = z.object({
  instanceId: z.string().min(3).max(128),
  name: z.string().min(2).max(100),
  domain: z.string().min(3).max(253),
  description: z.string().max(500).nullable().optional(),
  region: z.string().max(60).nullable().optional(),
  languages: z.array(z.string()).max(20).optional(),
  tags: z.array(z.string()).max(30).optional(),
  features: z.array(z.string()).max(30).optional(),
  publicKey: z.string().min(32).max(512),
  /**
   * 11th-audit: proof that the caller OPERATES the instance whose key
   * is being registered. Flow: GET /api/directory/register/challenge?
   * instanceId=… → {challenge, expiresIn} (Redis, 10 min, one-time);
   * the instance signs the challenge with the PRIVATE key matching
   * publicKey; registration verifies the signature. Without this, any
   * user could squat an arbitrary instanceId ahead of the real
   * operator (registration DoS) or register a domain they don't
   * control.
   */
  challenge: z.string().min(16).max(128),
  challengeSignature: z.string().min(64).max(256),
}).strict();

function parsePublicKeyPemOrDer(stored: string): ReturnType<typeof createPublicKey> | null {
  try {
    if (stored.includes('-----BEGIN')) return createPublicKey(stored);
    return createPublicKey({
      key: Buffer.from(stored, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

/**
 * POST /api/directory/register — register or update a self-hosted instance
 * in the discovery directory. The caller must be authenticated (the official
 * instance owner who controls registration). The domain is validated as an
 * HTTPS origin; new registrations start unlisted and unverified — an admin
 * must approve (set isListed + isVerified) before the instance appears
 * publicly.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;

  let body: z.infer<typeof RegisterSchema>;
  try {
    body = RegisterSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Validate the domain as a real HTTPS origin (rejects private IPs, etc.).
  let normalizedDomain: string;
  try {
    normalizedDomain = normalizeRegistryInstanceUrl(body.domain);
  } catch {
    return NextResponse.json({ error: 'Domain must be a valid HTTPS origin' }, { status: 400 });
  }

  // Challenge verification (11th-audit ownership proof).
  try {
    const { redis } = await import('@/lib/redis');
    const challengeKey = `lf:register-challenge:${body.instanceId}`;
    const challenge = await redis.getdel(challengeKey);
    if (!challenge || challenge !== body.challenge) {
      return NextResponse.json(
        { error: 'Challenge expired or invalid. Request a fresh one via GET /api/directory/register/challenge.' },
        { status: 401 }
      );
    }
    const pubKey = parsePublicKeyPemOrDer(body.publicKey);
    if (!pubKey) {
      return NextResponse.json({ error: 'publicKey is not a usable key' }, { status: 400 });
    }
    const signedOk = edVerify(
      null,
      Buffer.from(
        JSON.stringify({ register: 1, instanceId: body.instanceId, challenge: body.challenge }),
        'utf8'
      ),
      pubKey,
      Buffer.from(body.challengeSignature, 'base64')
    );
    if (!signedOk) {
      return NextResponse.json(
        { error: 'Challenge signature does not match publicKey — registration refused.' },
        { status: 401 }
      );
    }
  } catch (err) {
    console.error('[directory/register] challenge verification failed:', (err as Error).message);
    return NextResponse.json({ error: 'Challenge verification failed' }, { status: 500 });
  }

  try {
    const db = getDb();
    const instance = await upsertRegistryInstance(db, {
      instanceId: body.instanceId,
      name: body.name,
      domain: normalizedDomain,
      description: body.description ?? null,
      region: body.region ?? null,
      languages: body.languages ?? [],
      tags: body.tags ?? [],
      features: body.features ?? [],
      publicKey: body.publicKey,
      // SEC-007: only the first registrant may update the entry.
      actorUserId: sessionResult.session.uid,
    });
    return NextResponse.json(
      {
        instance: {
          instanceId: instance.instanceId,
          name: instance.name,
          domain: instance.domain,
          isListed: instance.isListed,
          isVerified: instance.isVerified,
        },
        message: instance.isListed
          ? 'Instance updated.'
          : 'Instance registered. An admin will review and list it.',
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof RegistryInstanceOwnedError) {
      return NextResponse.json(
        { error: 'This instance is registered by another user' },
        { status: 403 }
      );
    }
    if (err instanceof RegistryInstanceUnclaimableError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    return NextResponse.json({ error: 'Failed to register instance' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 4096,
  rateLimit: { identifier: 'directory-register', config: { windowMs: 60_000, maxRequests: 5 } },
});
