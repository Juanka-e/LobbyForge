import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getRegistryInstanceByInstanceId,
  heartbeatRegistryInstance,
} from '@lobbyforge/db';
import { redis } from '@/lib/redis';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * LF-SEC-007: heartbeats are SIGNED by the instance — a human web
 * session is no longer sufficient to update another instance's public
 * stats (the directory ranks on this data, so integrity matters).
 *
 * Wire format (Ed25519 over the canonical JSON, exact key order):
 *   {
 *     "instanceId": "...",
 *     "timestamp": 1788850000,          // unix seconds
 *     "nonce": "base64url-random",      // replay guard
 *     "stats": { "onlineUsers": 1, "publicRoomsCount": 2,
 *                "version": "0.2.0", "doctorScore": 97 },
 *     "signature": "base64(Ed25519(canonical))"
 *   }
 * canonical = JSON.stringify({instanceId, timestamp, nonce, stats})
 *
 * The server verifies against the publicKey stored at REGISTRATION
 * (owner-gated), enforces a ±300s timestamp window and burns the nonce
 * in Redis for the same window. Blocked instances' stats are still
 * recorded (the listing already filters isBlocked) — documented
 * behavior, not an oversight.
 */
const MAX_SKEW_SECONDS = 300;
const NONCE_TTL_SECONDS = 300;

const StatsSchema = z.object({
  onlineUsers: z.number().int().min(0).max(1_000_000).optional(),
  publicRoomsCount: z.number().int().min(0).max(100_000).optional(),
  version: z.string().max(60).optional(),
  doctorScore: z.number().int().min(0).max(100).optional(),
}).strict();

const HeartbeatSchema = z.object({
  instanceId: z.string().min(3).max(128),
  timestamp: z.number().int().positive(),
  nonce: z.string().min(16).max(64),
  stats: StatsSchema,
  signature: z.string().min(64).max(256),
}).strict();

type HeartbeatBody = z.infer<typeof HeartbeatSchema>;

/** Canonical signed payload — FIXED key order, do not reorder. */
function canonicalHeartbeatPayload(body: HeartbeatBody): string {
  return JSON.stringify({
    instanceId: body.instanceId,
    timestamp: body.timestamp,
    nonce: body.nonce,
    stats: body.stats,
  });
}

async function loadPublicKey(stored: string): Promise<import('node:crypto').KeyObject | null> {
  const { createPublicKey } = await import('node:crypto');
  try {
    if (stored.includes('-----BEGIN')) {
      return createPublicKey(stored);
    }
    // Raw base64 — assume a DER SubjectPublicKeyInfo (the standard
    // export format for Ed25519 public keys).
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
  let body: HeartbeatBody;
  try {
    body = HeartbeatSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Timestamp freshness — reject stale and far-future payloads.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - body.timestamp) > MAX_SKEW_SECONDS) {
    return NextResponse.json({ error: 'Heartbeat timestamp outside the allowed window' }, { status: 401 });
  }

  try {
    const instance = await getRegistryInstanceByInstanceId(getDb(), body.instanceId);
    if (!instance) {
      return NextResponse.json({ error: 'Unknown instance' }, { status: 404 });
    }

    const publicKey = await loadPublicKey(instance.publicKey);
    if (!publicKey) {
      // A malformed stored key is a registration-side problem; fail
      // closed for heartbeats (never accept unsigned).
      return NextResponse.json({ error: 'Instance key is not usable' }, { status: 500 });
    }

    const { verify } = await import('node:crypto');
    const signatureOk = verify(
      null,
      Buffer.from(canonicalHeartbeatPayload(body), 'utf8'),
      publicKey,
      Buffer.from(body.signature, 'base64')
    );
    if (!signatureOk) {
      return NextResponse.json({ error: 'Invalid heartbeat signature' }, { status: 401 });
    }

    // Replay guard — the nonce burns for the whole skew window, so a
    // captured heartbeat cannot be re-sent within it.
    const nonceKey = `lf:hb-nonce:${body.instanceId}:${body.nonce}`;
    const burned = await redis.set(nonceKey, '1', 'EX', NONCE_TTL_SECONDS, 'NX');
    if (burned !== 'OK') {
      return NextResponse.json({ error: 'Replayed heartbeat nonce' }, { status: 401 });
    }

    await heartbeatRegistryInstance(getDb(), body.instanceId, {
      onlineUsers: body.stats.onlineUsers,
      publicRoomsCount: body.stats.publicRoomsCount,
      version: body.stats.version,
      doctorScore: body.stats.doctorScore,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Failed to record heartbeat' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 2048,
  rateLimit: { identifier: 'directory-heartbeat', config: { windowMs: 60_000, maxRequests: 10 } },
});
