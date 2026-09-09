import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual, verify as edVerify, createPublicKey } from 'node:crypto';
import { z } from 'zod';
import {
  getRegistryInstanceByInstanceId,
  rotateRegistryInstanceKey,
} from '@lobbyforge/db';
import { redis } from '@/lib/redis';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/directory/rotate-key — rotate the instance's heartbeat
 * signing key (10th-audit finding 8).
 *
 * Authentication (all three required):
 *   1. the OWNER's browser session (upsert ownership rules apply);
 *   2. a PROOF signature made with the CURRENT (old) private key over
 *      the canonical rotation payload — proving control of the key
 *      being retired, so a stolen session alone cannot swap keys;
 *   3. fresh timestamp + one-time nonce (same replay guards as
 *      heartbeats).
 *
 * If the stored key is unusable (lost private key), recovery is an
 * ADMIN flow, not this endpoint.
 */

const RotateSchema = z.object({
  instanceId: z.string().min(3).max(128),
  newPublicKey: z.string().min(32).max(512),
  timestamp: z.number().int().positive(),
  nonce: z.string().min(16).max(64),
  proofSignature: z.string().min(64).max(256),
}).strict();

const MAX_SKEW_SECONDS = 300;

function canonicalRotationPayload(input: z.infer<typeof RotateSchema>): string {
  return JSON.stringify({
    rotate: 1,
    instanceId: input.instanceId,
    newPublicKey: input.newPublicKey,
    timestamp: input.timestamp,
    nonce: input.nonce,
  });
}

async function handlePost(req: Request): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;

  let body: z.infer<typeof RotateSchema>;
  try {
    body = RotateSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
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
      return NextResponse.json({ error: 'Only the instance owner may rotate the key' }, { status: 403 });
    }

    // Verify the OLD key still works — the proof is signed with it.
    const oldKey = createPublicKey(
      instance.publicKey.includes('-----BEGIN')
        ? instance.publicKey
        : { key: Buffer.from(instance.publicKey, 'base64'), format: 'der', type: 'spki' }
    );
    const proofOk = edVerify(
      null,
      Buffer.from(canonicalRotationPayload(body), 'utf8'),
      oldKey,
      Buffer.from(body.proofSignature, 'base64')
    );
    if (!proofOk) {
      return NextResponse.json(
        { error: 'Proof signature invalid — the current private key must sign the rotation' },
        { status: 401 }
      );
    }

    // New key must be a USABLE public key (shape-check by parsing).
    try {
      createPublicKey(
        body.newPublicKey.includes('-----BEGIN')
          ? body.newPublicKey
          : { key: Buffer.from(body.newPublicKey, 'base64'), format: 'der', type: 'spki' }
      );
    } catch {
      return NextResponse.json({ error: 'newPublicKey is not a usable key' }, { status: 400 });
    }

    // Nonce replay guard (shared bus with heartbeats, rotate-prefixed).
    const nonceKey = `lf:hb-nonce:rotate:${body.instanceId}:${body.nonce}`;
    const burned = await redis.set(nonceKey, '1', 'EX', 2 * MAX_SKEW_SECONDS + 60, 'NX');
    if (burned !== 'OK') {
      return NextResponse.json({ error: 'Replayed nonce' }, { status: 401 });
    }

    await rotateRegistryInstanceKey(getDb(), {
      instanceId: body.instanceId,
      ownerUserId: sessionResult.session.uid,
      newPublicKey: body.newPublicKey,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Key rotation failed' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 4096,
  rateLimit: { identifier: 'directory-rotate-key', config: { windowMs: 60_000, maxRequests: 3 } },
});
