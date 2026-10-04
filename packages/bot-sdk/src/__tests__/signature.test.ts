/**
 * Event endpoint signatures (BOT_API_V2 §5.2): the SDK's dependency-free
 * HMAC-SHA256 is pinned to node:crypto, the format to the server's
 * `signDelivery` (`v1=<hex HMAC(secret, timestamp + "." + body)>`), and
 * verification is checked for tampering and the replay window.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacSha256, sha256, signatureToleranceSeconds } from '../signature.js';
import { DEFAULT_SIGNATURE_TOLERANCE_SECONDS, signPayload, verifySignature } from '../index.js';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const SECRET = 'whsec_k3y-for-tests_0123456789abcdefghijklmnopq';
const NOW_MS = Date.UTC(2026, 9, 3, 12, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);
const BODY = JSON.stringify({
  id: '70000000-0000-4000-8000-000000000001',
  event: 'interaction_create',
  timestamp: NOW_S,
  data: { interaction: { commandName: 'roll', user: { displayName: 'Ayşe 🎲' } } },
});

/** What the instance sends (apps/web/lib/bots/event-delivery.ts `signDelivery`). */
function serverSignature(secret: string, timestamp: number | string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;
}

describe('sha256 / hmacSha256', () => {
  it('matches the FIPS 180-4 and RFC 4231 vectors', () => {
    const enc = new TextEncoder();
    expect(hex(sha256(enc.encode('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(sha256(enc.encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // RFC 4231 test case 2 and 6 (key longer than the block).
    expect(hex(hmacSha256(enc.encode('Jefe'), enc.encode('what do ya want for nothing?')))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
    );
    expect(
      hex(hmacSha256(new Uint8Array(131).fill(0xaa), enc.encode('Test Using Larger Than Block-Size Key - Hash Key First')))
    ).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  });

  it('agrees with node:crypto on random inputs around every padding boundary', () => {
    for (let length = 0; length <= 200; length += 1) {
      const data = randomBytes(length);
      expect(hex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'));
      const key = randomBytes((length * 7) % 150);
      expect(hex(hmacSha256(key, data))).toBe(createHmac('sha256', key).update(data).digest('hex'));
    }
  });
});

describe('signPayload', () => {
  it('produces exactly what the instance sends', () => {
    expect(signPayload({ secret: SECRET, timestamp: NOW_S, body: BODY })).toBe(serverSignature(SECRET, NOW_S, BODY));
    const bytes = new TextEncoder().encode(BODY);
    expect(signPayload({ secret: SECRET, timestamp: String(NOW_S), body: bytes })).toBe(
      serverSignature(SECRET, NOW_S, BODY)
    );
    expect(signPayload({ secret: SECRET, timestamp: NOW_S, body: bytes.buffer as ArrayBuffer })).toBe(
      serverSignature(SECRET, NOW_S, BODY)
    );
  });
});

describe('verifySignature', () => {
  const valid = { secret: SECRET, timestamp: String(NOW_S), body: BODY, signature: serverSignature(SECRET, NOW_S, BODY), now: NOW_MS };

  it('accepts a genuine delivery (string or raw bytes)', () => {
    expect(verifySignature(valid)).toBe(true);
    expect(verifySignature({ ...valid, body: new TextEncoder().encode(BODY) })).toBe(true);
    expect(verifySignature({ ...valid, timestamp: NOW_S })).toBe(true);
    expect(verifySignature({ ...valid, signature: valid.signature.toUpperCase().replace('V1=', 'v1=') })).toBe(true);
  });

  it('rejects a tampered body, a wrong secret, a different timestamp or a bad signature', () => {
    expect(verifySignature({ ...valid, body: BODY.replace('roll', 'ban') })).toBe(false);
    expect(verifySignature({ ...valid, body: `${BODY} ` })).toBe(false);
    expect(verifySignature({ ...valid, secret: `${SECRET}x` })).toBe(false);
    expect(verifySignature({ ...valid, timestamp: String(NOW_S - 1) })).toBe(false);
    expect(verifySignature({ ...valid, signature: valid.signature.slice(0, -1) })).toBe(false);
    expect(verifySignature({ ...valid, signature: valid.signature.slice(3) })).toBe(false); // no v1=
    expect(verifySignature({ ...valid, signature: `v0=${valid.signature.slice(3)}` })).toBe(false);
    expect(verifySignature({ ...valid, signature: '' })).toBe(false);
    expect(verifySignature({ ...valid, signature: undefined })).toBe(false);
  });

  it('enforces the replay window (5 minutes by default, both directions)', () => {
    expect(DEFAULT_SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    const at = (offsetSeconds: number) => {
      const ts = NOW_S + offsetSeconds;
      return verifySignature({ ...valid, timestamp: String(ts), signature: serverSignature(SECRET, ts, BODY) });
    };
    expect(at(-300)).toBe(true);
    expect(at(-301)).toBe(false);
    expect(at(300)).toBe(true);
    expect(at(301)).toBe(false);
    const old = NOW_S - 600;
    const signedOld = { ...valid, timestamp: String(old), signature: serverSignature(SECRET, old, BODY) };
    expect(verifySignature(signedOld)).toBe(false);
    expect(verifySignature({ ...signedOld, toleranceSeconds: 900 })).toBe(true);
    expect(verifySignature({ ...valid, toleranceSeconds: 0 })).toBe(true);
  });

  it('clamps the tolerance to 1..3600 s; Infinity / NaN / junk mean the 300 s default — never "no replay check"', () => {
    const signedAt = (offsetSeconds: number) => {
      const ts = NOW_S + offsetSeconds;
      return { ...valid, timestamp: String(ts), signature: serverSignature(SECRET, ts, BODY) };
    };
    const yearOld = signedAt(-365 * 24 * 3600);
    const hourAndABitOld = signedAt(-3601);
    const tenMinutesOld = signedAt(-600);
    // Infinity / NaN used to accept a year-old replay (or any non-negative number did).
    expect(verifySignature({ ...yearOld, toleranceSeconds: Number.POSITIVE_INFINITY })).toBe(false);
    expect(verifySignature({ ...tenMinutesOld, toleranceSeconds: Number.POSITIVE_INFINITY })).toBe(false); // → 300
    expect(verifySignature({ ...signedAt(-299), toleranceSeconds: Number.POSITIVE_INFINITY })).toBe(true);
    expect(verifySignature({ ...tenMinutesOld, toleranceSeconds: Number.NaN })).toBe(false);
    expect(verifySignature({ ...signedAt(-299), toleranceSeconds: Number.NaN })).toBe(true);
    // A huge finite tolerance is capped at one hour.
    expect(verifySignature({ ...yearOld, toleranceSeconds: 10 ** 12 })).toBe(false);
    expect(verifySignature({ ...hourAndABitOld, toleranceSeconds: 10 ** 12 })).toBe(false);
    expect(verifySignature({ ...signedAt(-3600), toleranceSeconds: 10 ** 12 })).toBe(true);
    // Zero or negative is the tightest window (1 s), not the default.
    expect(verifySignature({ ...signedAt(-2), toleranceSeconds: -5 })).toBe(false);
    expect(verifySignature({ ...signedAt(-1), toleranceSeconds: -5 })).toBe(true);

    expect(signatureToleranceSeconds(undefined)).toBe(300);
    expect(signatureToleranceSeconds('900')).toBe(300);
    expect(signatureToleranceSeconds(Number.NEGATIVE_INFINITY)).toBe(300);
    expect(signatureToleranceSeconds(0)).toBe(1);
    expect(signatureToleranceSeconds(-10)).toBe(1);
    expect(signatureToleranceSeconds(60)).toBe(60);
    expect(signatureToleranceSeconds(86_400)).toBe(3600);
  });

  it('accepts any matching entry of a multi-signature header', () => {
    expect(verifySignature({ ...valid, signature: `v1=${'0'.repeat(64)}, ${valid.signature}` })).toBe(true);
    expect(verifySignature({ ...valid, signature: `v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}` })).toBe(false);
  });

  it('never throws on malformed input', () => {
    const garbage = [
      { ...valid, secret: '' },
      { ...valid, secret: undefined as unknown as string },
      { ...valid, timestamp: 'yesterday' },
      { ...valid, timestamp: '1e9' },
      { ...valid, timestamp: '-5' },
      { ...valid, body: undefined as unknown as string },
      { ...valid, signature: 42 as unknown as string },
    ];
    for (const input of garbage) expect(verifySignature(input)).toBe(false);
  });
});
