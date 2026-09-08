/**
 * LF-SEC-007 sender half: the instance-side signer must produce payloads
 * the SERVER accepts — canonical key order, sanitized stats, real
 * Ed25519 signatures — and the sender must handle transport errors
 * without throwing.
 */
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildSignedHeartbeat,
  canonicalHeartbeatPayload,
  sanitizeHeartbeatStats,
  sendDirectoryHeartbeat,
} from '../directory-heartbeat';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicKeyObj = createPublicKey(
  publicKey.export({ format: 'pem', type: 'spki' }).toString()
);

describe('sanitizeHeartbeatStats', () => {
  it('keeps canonical order and drops undefined keys', () => {
    const clean = sanitizeHeartbeatStats({
      doctorScore: 90,
      version: '0.2.0',
      publicRoomsCount: 3,
      onlineUsers: 7,
    });
    // Insertion order must match the canonical onlineUsers →
    // publicRoomsCount → version → doctorScore order.
    expect(Object.keys(clean)).toEqual([
      'onlineUsers',
      'publicRoomsCount',
      'version',
      'doctorScore',
    ]);
    expect(JSON.parse(JSON.stringify(clean))).toEqual({
      onlineUsers: 7,
      publicRoomsCount: 3,
      version: '0.2.0',
      doctorScore: 90,
    });
  });

  it('omits absent keys entirely (never nulls)', () => {
    const clean = sanitizeHeartbeatStats({ onlineUsers: 1 });
    expect(Object.keys(clean)).toEqual(['onlineUsers']);
  });
});

describe('buildSignedHeartbeat — server-compatible signature', () => {
  it('signs the canonical payload the server verifies', () => {
    const signed = buildSignedHeartbeat({
      instanceId: 'inst-9',
      stats: { onlineUsers: 12, version: '0.2.0' },
      privateKeyPem,
      nowMs: 1_788_850_000_000,
      nonce: 'fixed-nonce-0123456789',
    });
    expect(signed.timestamp).toBe(1_788_850_000);
    // The server's canonical (route.ts) — identical construction.
    const serverCanonical = JSON.stringify({
      instanceId: signed.instanceId,
      timestamp: signed.timestamp,
      nonce: signed.nonce,
      stats: signed.stats,
    });
    expect(canonicalHeartbeatPayload(signed)).toBe(serverCanonical);
    const ok = verify(
      null,
      Buffer.from(serverCanonical, 'utf8'),
      publicKeyObj,
      Buffer.from(signed.signature, 'base64')
    );
    expect(ok).toBe(true);
  });

  it('uses a fresh unguessable nonce per call', () => {
    const a = buildSignedHeartbeat({ instanceId: 'i', stats: {}, privateKeyPem });
    const b = buildSignedHeartbeat({ instanceId: 'i', stats: {}, privateKeyPem });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.nonce.length).toBeGreaterThanOrEqual(16);
  });
});

describe('sendDirectoryHeartbeat', () => {
  it('posts the signed body to the directory endpoint', async () => {
    const signed = buildSignedHeartbeat({ instanceId: 'i', stats: { onlineUsers: 1 }, privateKeyPem });
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await sendDirectoryHeartbeat({
      directoryOrigin: 'https://directory.example.com/',
      signed,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(captured!.url).toBe('https://directory.example.com/api/directory/heartbeat');
    expect(captured!.init.method).toBe('POST');
    expect(JSON.parse(String(captured!.init.body))).toEqual(signed);
  });

  it('reports non-2xx with the server error detail', async () => {
    const signed = buildSignedHeartbeat({ instanceId: 'i', stats: {}, privateKeyPem });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'Invalid heartbeat signature' }), { status: 401 })) as unknown as typeof fetch;
    const result = await sendDirectoryHeartbeat({ directoryOrigin: 'https://d.example.com', signed, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain('signature');
  });

  it('surfaces transport failures instead of throwing', async () => {
    const signed = buildSignedHeartbeat({ instanceId: 'i', stats: {}, privateKeyPem });
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await sendDirectoryHeartbeat({ directoryOrigin: 'https://down.example.com', signed, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toBe('ECONNREFUSED');
  });
});
