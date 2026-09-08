/**
 * Instance-side directory heartbeat signer (LF-SEC-007, sender half).
 *
 * The directory's heartbeat endpoint only accepts Ed25519-signed
 * payloads verified against the publicKey stored at registration. This
 * module builds and signs those payloads for the lfctl CLI
 * (`lfctl directory heartbeat`) — the canonical JSON matches the
 * server's verifier EXACTLY (fixed key order; undefined stats keys are
 * omitted, not nulled):
 *
 *   JSON.stringify({ instanceId, timestamp, nonce, stats })
 */
import { randomBytes, sign as edSign, createPrivateKey } from 'node:crypto';

export interface HeartbeatStats {
  onlineUsers?: number;
  publicRoomsCount?: number;
  version?: string;
  doctorScore?: number;
}

export interface SignedHeartbeat {
  instanceId: string;
  timestamp: number;
  nonce: string;
  stats: HeartbeatStats;
  signature: string;
}

/** Drop undefined keys while keeping the CANONICAL order. */
export function sanitizeHeartbeatStats(stats: HeartbeatStats): HeartbeatStats {
  const clean: HeartbeatStats = {};
  if (stats.onlineUsers !== undefined) clean.onlineUsers = stats.onlineUsers;
  if (stats.publicRoomsCount !== undefined) clean.publicRoomsCount = stats.publicRoomsCount;
  if (stats.version !== undefined) clean.version = stats.version;
  if (stats.doctorScore !== undefined) clean.doctorScore = stats.doctorScore;
  return clean;
}

/** Canonical payload string — byte-identical to the server's builder. */
export function canonicalHeartbeatPayload(signed: Omit<SignedHeartbeat, 'signature'>): string {
  return JSON.stringify({
    instanceId: signed.instanceId,
    timestamp: signed.timestamp,
    nonce: signed.nonce,
    stats: signed.stats,
  });
}

export function buildSignedHeartbeat(input: {
  instanceId: string;
  stats: HeartbeatStats;
  privateKeyPem: string;
  nowMs?: number;
  nonce?: string;
}): SignedHeartbeat {
  const base = {
    instanceId: input.instanceId,
    timestamp: Math.floor((input.nowMs ?? Date.now()) / 1000),
    nonce: input.nonce ?? randomBytes(24).toString('base64url'),
    stats: sanitizeHeartbeatStats(input.stats),
  };
  const privateKey = createPrivateKey(input.privateKeyPem);
  const signature = edSign(
    null,
    Buffer.from(canonicalHeartbeatPayload(base), 'utf8'),
    privateKey
  ).toString('base64');
  return { ...base, signature };
}

export interface HeartbeatSendResult {
  ok: boolean;
  status: number;
  error?: string;
}

/** POST the signed heartbeat to the directory. */
export async function sendDirectoryHeartbeat(input: {
  directoryOrigin: string;
  signed: SignedHeartbeat;
  fetchImpl?: typeof fetch;
}): Promise<HeartbeatSendResult> {
  const doFetch = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${input.directoryOrigin.replace(/\/$/, '')}/api/directory/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input.signed),
    });
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
  if (res.ok) return { ok: true, status: res.status };
  const detail = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, status: res.status, error: detail.error ?? `HTTP ${res.status}` };
}
