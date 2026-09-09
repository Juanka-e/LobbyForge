import { NextResponse } from 'next/server';
import { createPublicKey, randomBytes, verify as edVerify } from 'node:crypto';
import { z } from 'zod';
import {
  changeRegistryInstanceDomain,
  getRegistryInstanceByInstanceId,
} from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { ssrfSafeGet } from '@/lib/ssrf-safe-fetch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/directory/change-domain — move a registered instance to a
 * NEW domain (13th-audit P1).
 *
 * Register no longer mutates the domain (its proof only ties the
 * REQUEST's key to the new domain — a hijacked owner session could
 * otherwise redirect discovery traffic anywhere). Changing the domain
 * requires ALL of:
 *   1. the OWNER's browser session;
 *   2. possession of the CURRENT stored private key — a nonce
 *      challenge signed with it (proves key control, not just session);
 *   3. the NEW domain to serve a valid .well-known verification
 *      document for the same instanceId + publicKey (the same
 *      server-side SSRF-safe proof registration uses);
 *   4. a timestamp window + one-time nonce (replay guard).
 */
const ChangeDomainSchema = z.object({
  instanceId: z.string().min(3).max(128),
  newDomain: z.string().min(3).max(253),
  timestamp: z.number().int().positive(),
  nonce: z.string().min(16).max(64),
  /** Ed25519(storedPrivateKey, canonical payload) — old-key proof. */
  oldKeySignature: z.string().min(64).max(256),
  /** Ed25519(newDomainPrivateKey, canonical payload) — domain proof. */
  domainProof: z.string().min(64).max(256),
}).strict();

const MAX_SKEW_SECONDS = 300;

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

async function handlePost(req: Request): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;

  let body: z.infer<typeof ChangeDomainSchema>;
  try {
    body = ChangeDomainSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Normalize the new domain as a real HTTPS origin (rejects private IPs).
  let normalizedDomain: string;
  try {
    const { normalizeRegistryInstanceUrl } = await import('@lobbyforge/registry');
    normalizedDomain = normalizeRegistryInstanceUrl(body.newDomain);
  } catch {
    return NextResponse.json({ error: 'New domain must be a valid HTTPS origin' }, { status: 400 });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - body.timestamp) > MAX_SKEW_SECONDS) {
    return NextResponse.json({ error: 'Timestamp outside the allowed window' }, { status: 401 });
  }

  try {
    const instance = await getRegistryInstanceByInstanceId(getDb(), body.instanceId);
    if (!instance) {
      return NextResponse.json({ error: 'Unknown instance' }, { status: 404 });
    }
    if (instance.ownerUserId !== sessionResult.session.uid) {
      return NextResponse.json({ error: 'Only the instance owner may change the domain' }, { status: 403 });
    }
    if (instance.domain === normalizedDomain) {
      return NextResponse.json({ error: 'Instance already uses this domain' }, { status: 400 });
    }

    // (2) Old-key possession proof over the canonical change payload.
    const oldKey = parsePublicKeyPemOrDer(instance.publicKey);
    if (!oldKey) {
      return NextResponse.json({ error: 'Stored key is not usable — use admin recovery' }, { status: 500 });
    }
    const canonicalChange = JSON.stringify({
      changeDomain: 1,
      instanceId: body.instanceId,
      oldDomain: instance.domain,
      newDomain: normalizedDomain,
      timestamp: body.timestamp,
      nonce: body.nonce,
    });
    const oldKeyOk = edVerify(
      null,
      Buffer.from(canonicalChange, 'utf8'),
      oldKey,
      Buffer.from(body.oldKeySignature, 'base64')
    );
    if (!oldKeyOk) {
      return NextResponse.json(
        { error: 'Old-key proof invalid — the current private key must sign the change' },
        { status: 401 }
      );
    }

    // (3) New-domain well-known proof (server-side, SSRF-safe).
    const wellKnown = `${normalizedDomain.replace(/\/$/, '')}/.well-known/lobbyforge-verification`;
    let docRes: Awaited<ReturnType<typeof ssrfSafeGet>>;
    try {
      docRes = await ssrfSafeGet(wellKnown);
    } catch (err) {
      return NextResponse.json(
        { error: `Could not verify the new domain (${(err as Error).message})` },
        { status: 400 }
      );
    }
    if (!docRes.ok) {
      return NextResponse.json({ error: `Verification endpoint returned HTTP ${docRes.status}` }, { status: 400 });
    }
    let doc: { instanceId?: unknown; publicKey?: unknown; proof?: unknown };
    try {
      doc = JSON.parse(docRes.body);
    } catch {
      return NextResponse.json({ error: 'Verification document is not valid JSON' }, { status: 400 });
    }
    if (doc.instanceId !== body.instanceId || typeof doc.publicKey !== 'string' || typeof doc.proof !== 'string') {
      return NextResponse.json({ error: 'Verification document mismatch' }, { status: 400 });
    }
    const docKey = parsePublicKeyPemOrDer(doc.publicKey);
    if (!docKey) {
      return NextResponse.json({ error: 'Document publicKey is not usable' }, { status: 400 });
    }
    // Verify the DOCUMENT's own proof (13th-audit cleanup: one proof
    // source — the document — instead of a request-carried twin).
    const canonicalDomain = JSON.stringify({
      verify: 1,
      instanceId: body.instanceId,
      domain: normalizedDomain,
      publicKey: doc.publicKey,
    });
    const docProofOk = edVerify(
      null,
      Buffer.from(canonicalDomain, 'utf8'),
      docKey,
      Buffer.from(doc.proof, 'base64')
    );
    if (!docProofOk) {
      return NextResponse.json({ error: 'Domain proof signature invalid' }, { status: 401 });
    }

    // (4) Nonce replay guard.
    const { redis } = await import('@/lib/redis');
    const burned = await redis.set(
      `lf:hb-nonce:change-domain:${body.instanceId}:${body.nonce}`,
      '1',
      'EX',
      2 * MAX_SKEW_SECONDS + 60,
      'NX'
    );
    if (burned !== 'OK') {
      return NextResponse.json({ error: 'Replayed nonce' }, { status: 401 });
    }

    const changed = await changeRegistryInstanceDomain(getDb(), {
      instanceId: body.instanceId,
      ownerUserId: sessionResult.session.uid,
      newDomain: normalizedDomain,
    });
    if (!changed) {
      return NextResponse.json({ error: 'Domain change failed' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, domain: normalizedDomain });
  } catch {
    return NextResponse.json({ error: 'Domain change failed' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 4096,
  rateLimit: { identifier: 'directory-change-domain', config: { windowMs: 60_000, maxRequests: 3 } },
});
