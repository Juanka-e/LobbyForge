import { NextResponse } from 'next/server';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { ssrfSafeGet } from '@/lib/ssrf-safe-fetch';
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
   * 12th-audit: proof that the caller controls the INSTANCE + DOMAIN.
   * The 11th-audit key challenge only proved the signature matched the
   * REQUEST'S OWN publicKey (an attacker just used their own keypair).
   * Real proof: the directory fetches
   * https://{domain}/.well-known/lobbyforge-verification over the
   * SSRF-safe IP-pinned client and verifies the document server-side —
   * only an operator who actually controls the domain can serve it.
   */
  /**
   * 15th-audit: account-bound challenge. The .well-known document is
   * PUBLIC — an attacker who saw it could replay the same tuple. The
   * nonce is bound to (userId, instanceId, domain); only that user's
   * submission can consume it.
   */
  registrationNonce: z.string().min(16).max(128),
  nonceSignature: z.string().min(64).max(256),
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
 * 12th-audit domain proof: fetch the instance's verification document
 * over the SSRF-safe client and verify it against the submitted key.
 * The instance operator serves:
 *   GET /.well-known/lobbyforge-verification →
 *   { instanceId, publicKey, proof }
 * where proof = Ed25519(privateKey,
 *   JSON.stringify({ verify: 1, instanceId, domain, publicKey })).
 */
async function verifyDomainOwnership(input: {
  instanceId: string;
  domain: string;
  publicKey: string;
}): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const pubKey = parsePublicKeyPemOrDer(input.publicKey);
  if (!pubKey) return { ok: false, error: 'publicKey is not a usable key', status: 400 };

  const wellKnown = `${input.domain.replace(/\/$/, '')}/.well-known/lobbyforge-verification`;
  let res: Awaited<ReturnType<typeof ssrfSafeGet>>;
  try {
    res = await ssrfSafeGet(wellKnown);
  } catch (err) {
    return {
      ok: false,
      error: `Could not verify the domain (fetch failed: ${(err as Error).message}). The instance must serve ${wellKnown}.`,
      status: 400,
    };
  }
  if (!res.ok) {
    return { ok: false, error: `Verification endpoint returned HTTP ${res.status}`, status: 400 };
  }
  let doc: { instanceId?: unknown; publicKey?: unknown; proof?: unknown };
  try {
    doc = JSON.parse(res.body);
  } catch {
    return { ok: false, error: 'Verification document is not valid JSON', status: 400 };
  }
  if (doc.instanceId !== input.instanceId) {
    return { ok: false, error: 'Verification document instanceId mismatch', status: 400 };
  }
  if (doc.publicKey !== input.publicKey) {
    return { ok: false, error: 'Verification document publicKey mismatch', status: 400 };
  }
  if (typeof doc.proof !== 'string') {
    return { ok: false, error: 'Verification document has no proof', status: 400 };
  }
  // 13th-audit cleanup: ONE proof source — the DOCUMENT's own proof,
  // verified against the document's own publicKey (which the caller's
  // body had to match above). The old request-carried twin signature
  // was redundant and error-prone.
  const canonical = JSON.stringify({
    verify: 1,
    instanceId: input.instanceId,
    domain: input.domain,
    publicKey: input.publicKey,
  });
  const signedOk = edVerify(
    null,
    Buffer.from(canonical, 'utf8'),
    pubKey,
    Buffer.from(doc.proof, 'base64')
  );
  if (!signedOk) {
    return { ok: false, error: 'Domain proof signature invalid', status: 401 };
  }
  return { ok: true };
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

  // 15th-audit: ACCOUNT-BOUND challenge — the nonce is stored against
  // (userId, instanceId, domain); only the user who requested it can
  // consume it. Closes the public-.well-known replay vector.
  try {
    const { redis } = await import('@/lib/redis');
    const challengeKey = `lf:reg-challenge:${sessionResult.session.uid}:${body.instanceId}:${normalizedDomain}`;
    const nonce = await redis.getdel(challengeKey);
    if (!nonce || nonce !== body.registrationNonce) {
      return NextResponse.json(
        { error: 'Registration challenge expired, invalid, or bound to a different account.' },
        { status: 401 }
      );
    }
    const nonceCanonical = JSON.stringify({
      register: 1,
      nonce,
      instanceId: body.instanceId,
      domain: normalizedDomain,
    });
    const nonceKey = parsePublicKeyPemOrDer(body.publicKey);
    if (!nonceKey) {
      return NextResponse.json({ error: 'publicKey is not a usable key' }, { status: 400 });
    }
    const nonceOk = edVerify(
      null,
      Buffer.from(nonceCanonical, 'utf8'),
      nonceKey,
      Buffer.from(body.nonceSignature, 'base64')
    );
    if (!nonceOk) {
      return NextResponse.json(
        { error: 'Nonce signature invalid — the instance private key must sign the account-bound challenge.' },
        { status: 401 }
      );
    }
  } catch (err) {
    console.error('[directory/register] challenge verification failed:', (err as Error).message);
    return NextResponse.json({ error: 'Challenge verification failed' }, { status: 500 });
  }

  // 12th-audit: DOMAIN OWNERSHIP PROOF — the directory fetches the
  // instance's .well-known document over the SSRF-safe IP-pinned
  // client and verifies instanceId + publicKey + proof server-side.
  // A self-chosen keypair alone proves nothing; only the domain's
  // real operator can serve the document.
  const domainProof = await verifyDomainOwnership({
    instanceId: body.instanceId,
    domain: normalizedDomain,
    publicKey: body.publicKey,
  });
  if (!domainProof.ok) {
    return NextResponse.json({ error: domainProof.error }, { status: domainProof.status });
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
