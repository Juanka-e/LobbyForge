/**
 * Event endpoint signatures (docs/BOT_API_V2.md §5.2).
 *
 * Every delivery to a bot's HTTPS endpoint carries
 *
 *   X-LobbyForge-Timestamp: <unix seconds>
 *   X-LobbyForge-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>
 *
 * `verifySignature` checks both — the HMAC in constant time, the timestamp
 * against a tolerance (5 minutes by default) so a captured delivery cannot
 * be replayed later. It is SYNCHRONOUS on purpose: a Promise is truthy, so
 * an async verifier dropped into `if (verifySignature(…))` would accept
 * every request. SHA-256 is implemented here (FIPS 180-4) so the SDK keeps
 * zero dependencies and runs unchanged in Node, Deno, Bun and browsers;
 * the tests pin it to `node:crypto`.
 */

// ---------------------------------------------------------------------------
// SHA-256 / HMAC-SHA256
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 digest of `data`. */
export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = data.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i]!);
  return out;
}

const BLOCK_SIZE = 64;

/** HMAC-SHA256 (RFC 2104). */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  let k = key.length > BLOCK_SIZE ? sha256(key) : key;
  if (k.length < BLOCK_SIZE) {
    const padded = new Uint8Array(BLOCK_SIZE);
    padded.set(k);
    k = padded;
  }
  const inner = new Uint8Array(BLOCK_SIZE + message.length);
  const outer = new Uint8Array(BLOCK_SIZE + 32);
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    inner[i] = k[i]! ^ 0x36;
    outer[i] = k[i]! ^ 0x5c;
  }
  inner.set(message, BLOCK_SIZE);
  outer.set(sha256(inner), BLOCK_SIZE);
  return sha256(outer);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

const encoder = new TextEncoder();

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// ---------------------------------------------------------------------------
// Signing / verification
// ---------------------------------------------------------------------------

/** The raw request body: the exact bytes received (or their UTF-8 string). */
export type SignedBody = string | Uint8Array | ArrayBuffer;

function bodyBytes(body: SignedBody): Uint8Array {
  if (typeof body === 'string') return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(body);
}

export interface SignPayloadInput {
  /** The endpoint secret returned once by `PUT /api/bot/v2/event-endpoint`. */
  secret: string;
  /** Unix seconds, exactly as sent in `X-LobbyForge-Timestamp`. */
  timestamp: number | string;
  body: SignedBody;
}

/** `v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>` — what the instance sends. */
export function signPayload(input: SignPayloadInput): string {
  const message = concat(encoder.encode(`${input.timestamp}.`), bodyBytes(input.body));
  return `v1=${toHex(hmacSha256(encoder.encode(input.secret), message))}`;
}

export interface VerifySignatureInput extends SignPayloadInput {
  /** The `X-LobbyForge-Signature` header (one or more comma-separated `v1=<hex>`). */
  signature: string | null | undefined;
  /**
   * Accept timestamps at most this many seconds old (or ahead). Default 300;
   * clamped to 1..3600 (`Infinity` / `NaN` → 300).
   */
  toleranceSeconds?: number;
  /** Current time in milliseconds (tests). Default `Date.now()`. */
  now?: number;
}

/** Default replay window: 5 minutes (§5.2). */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;
/** The tolerance a caller may choose is clamped to 1 s … 1 hour. */
export const MIN_SIGNATURE_TOLERANCE_SECONDS = 1;
export const MAX_SIGNATURE_TOLERANCE_SECONDS = 3600;

/**
 * The replay window actually applied: a finite number is clamped to
 * 1..3600 s (0 or a negative number → 1 s, a day → 1 hour); anything else —
 * `Infinity`, `NaN`, a string, nothing — is the 300 s default. A
 * misconfigured value can narrow the window, never switch replay
 * protection off.
 */
export function signatureToleranceSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  return Math.min(MAX_SIGNATURE_TOLERANCE_SECONDS, Math.max(MIN_SIGNATURE_TOLERANCE_SECONDS, value));
}

/** Compare two strings without an early exit on the first difference. */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * True only when the signature matches the body AND the timestamp is
 * within the tolerance. Never throws — anything malformed is `false`.
 *
 * ```ts
 * const ok = verifySignature({
 *   secret: process.env.LOBBYFORGE_ENDPOINT_SECRET!,
 *   timestamp: req.headers['x-lobbyforge-timestamp'],
 *   signature: req.headers['x-lobbyforge-signature'],
 *   body: rawBody, // the bytes as received — not re-serialized JSON
 * });
 * ```
 */
export function verifySignature(input: VerifySignatureInput): boolean {
  try {
    const { secret, signature } = input;
    if (typeof secret !== 'string' || !secret) return false;
    if (typeof signature !== 'string' || !signature) return false;
    const rawTimestamp = typeof input.timestamp === 'number' ? String(input.timestamp) : input.timestamp;
    if (typeof rawTimestamp !== 'string' || !/^\d{1,12}$/.test(rawTimestamp)) return false;
    const tolerance = signatureToleranceSeconds(input.toleranceSeconds);
    const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
    if (Math.abs(nowSeconds - Number(rawTimestamp)) > tolerance) return false;
    if (input.body === null || input.body === undefined) return false;

    const expected = signPayload({ secret, timestamp: rawTimestamp, body: input.body }).slice(3);
    let matched = false;
    for (const part of signature.split(',')) {
      const trimmed = part.trim();
      if (!trimmed.startsWith('v1=')) continue;
      // Every candidate is compared in full — no short-circuit on a match.
      if (constantTimeEqual(trimmed.slice(3).toLowerCase(), expected)) matched = true;
    }
    return matched;
  } catch {
    return false;
  }
}
