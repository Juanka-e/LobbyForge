/**
 * Directory verification proof generation (17th-audit).
 *
 * The proof is Ed25519(privateKey, canonical payload) — only the
 * instance operator who holds the private key can produce it. The
 * canonical payload matches exactly what the official registry's
 * verifier reconstructs:
 *
 *   JSON.stringify({ verify: 1, instanceId, domain, publicKey })
 */
import { sign as edSign, createPrivateKey } from 'node:crypto';

export function canonicalVerificationPayload(input: {
  instanceId: string;
  domain: string;
  publicKey: string;
}): string {
  return JSON.stringify({
    verify: 1,
    instanceId: input.instanceId,
    domain: input.domain,
    publicKey: input.publicKey,
  });
}

export function generateDirectoryProof(input: {
  instanceId: string;
  domain: string;
  publicKey: string;
  privateKeyPem: string;
}): string {
  const canonical = canonicalVerificationPayload(input);
  const privateKey = createPrivateKey(input.privateKeyPem);
  return edSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
}

/**
 * Runtime proof: read the stored encrypted private key, decrypt, and
 * sign the canonical payload. Returns null if the key is not available
 * (operator must run lfctl to set it up).
 *
 * NOTE: this currently reads from the instance settings table's
 * privateKeyEncrypted column. In production the encryption key comes
 * from LOBBYFORGE_SESSION_SECRET (the operator sets this up during
 * lfctl directory keygen).
 */
export async function getDirectoryProof(
  instanceId: string,
  domain: string,
  publicKey: string
): Promise<string | null> {
  // The proof is pre-computed by the operator (lfctl directory proof)
  // and stored — we don't decrypt keys on every request. For now the
  // operator stores the proof alongside the keypair. When the full
  // onboarding flow lands, this reads from a dedicated column.
  // TODO: implement the proof storage column + lfctl proof command.
  const { redis } = await import('@/lib/redis');
  const proof = await redis.get(`lf:directory-proof:${instanceId}`);
  return proof;
}
