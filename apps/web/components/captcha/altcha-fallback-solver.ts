/**
 * ALTCHA v2 proof of work in plain JavaScript — for pages without Web Crypto.
 *
 * Browsers expose `crypto.subtle` only in a secure context (HTTPS, or
 * localhost). A self-hosted instance reached over plain HTTP on a LAN has
 * none, and ALTCHA's widget then refuses to run, so nobody could sign up or
 * join as a guest there. This solver does the same work without Web Crypto
 * and produces the same solution and payload the widget would.
 *
 * The algorithm is altcha-lib v2's (`createChallenge` / `solveChallenge` /
 * `verifySolution` in node_modules/altcha-lib/dist/esm/v2/pow.js):
 *
 *   password    = nonce bytes ‖ counter as a big-endian uint32
 *   derived key = PBKDF2-HMAC-SHA256(password, salt, cost, keyLength)
 *                 (or, for "SHA-256", cost rounds of SHA-256 over salt ‖ password)
 *   solved when the derived key starts with keyPrefix
 *
 * Every number comes from the challenge — the algorithm, cost, key length,
 * prefix, salt and nonce; counters are tried from 0 upwards — so a server
 * that changes its difficulty needs no change here.
 *
 * SHA-256 follows FIPS 180-4 (adapted from packages/bot-sdk/src/signature.ts),
 * rewritten on 32-bit words with preallocated buffers: an HMAC key's two pad
 * states are computed once per counter, so each PBKDF2 round costs exactly
 * two compressions and allocates nothing.
 */

/** The algorithms this solver can do. SHA-384/512 and the WASM ones are not among them. */
export const FALLBACK_ALGORITHMS = ['PBKDF2/SHA-256', 'SHA-256'] as const;
export type FallbackAlgorithm = (typeof FALLBACK_ALGORITHMS)[number];

export interface AltchaV2Parameters {
  algorithm: string;
  nonce: string;
  salt: string;
  cost: number;
  keyLength: number;
  keyPrefix: string;
  expiresAt?: number;
  [key: string]: unknown;
}

export interface AltchaV2Challenge {
  parameters: AltchaV2Parameters;
  signature?: string;
}

export interface AltchaSolution {
  counter: number;
  derivedKey: string;
  time: number;
}

// ---------------------------------------------------------------------------
// SHA-256 on 32-bit words
// ---------------------------------------------------------------------------

const K = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const IV = Int32Array.from([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/**
 * One SHA-256 compression: `out = state + rounds(state, w[0..15])`. `w` is
 * a 64-word schedule whose first 16 words hold the block; words 16..63 are
 * overwritten. `out` may be `state`.
 */
function compress(state: Int32Array, w: Int32Array, out: Int32Array): void {
  for (let i = 16; i < 64; i += 1) {
    const w15 = w[i - 15]!;
    const w2 = w[i - 2]!;
    const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
    const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
  }
  let a = state[0]!;
  let b = state[1]!;
  let c = state[2]!;
  let d = state[3]!;
  let e = state[4]!;
  let f = state[5]!;
  let g = state[6]!;
  let h = state[7]!;
  for (let i = 0; i < 64; i += 1) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  out[0] = (state[0]! + a) | 0;
  out[1] = (state[1]! + b) | 0;
  out[2] = (state[2]! + c) | 0;
  out[3] = (state[3]! + d) | 0;
  out[4] = (state[4]! + e) | 0;
  out[5] = (state[5]! + f) | 0;
  out[6] = (state[6]! + g) | 0;
  out[7] = (state[7]! + h) | 0;
}

/** Load 64 bytes from `bytes[offset…]` (zero-filled past the end) into w[0..15]. */
function loadBlock(w: Int32Array, bytes: Uint8Array, offset: number): void {
  for (let i = 0; i < 16; i += 1) {
    const at = offset + i * 4;
    w[i] = ((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
  }
}

/**
 * Finish a hash whose first `already` bytes went into `state`: absorb
 * `message`, pad (FIPS 180-4 §5.1.1) and write the digest words to `out`.
 */
function finish(state: Int32Array, already: number, message: Uint8Array, w: Int32Array, out: Int32Array): void {
  const total = already + message.length;
  const padded = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  const bits = total * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bits >>> 0);
  out.set(state);
  for (let offset = 0; offset < padded.length; offset += 64) {
    loadBlock(w, padded, offset);
    compress(out, w, out);
  }
}

function wordsToBytes(words: Int32Array, length: number, into?: Uint8Array, at = 0): Uint8Array {
  const out = into ?? new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[at + i] = (words[i >> 2]! >>> (24 - (i & 3) * 8)) & 0xff;
  return out;
}

/** SHA-256 of `data`. */
export function sha256(data: Uint8Array): Uint8Array {
  const w = new Int32Array(64);
  const out = new Int32Array(8);
  finish(IV, 0, data, w, out);
  return wordsToBytes(out, 32);
}

// ---------------------------------------------------------------------------
// PBKDF2-HMAC-SHA256
// ---------------------------------------------------------------------------

/** Reusable buffers for one solver (one worker). */
class Pbkdf2 {
  private readonly w = new Int32Array(64);
  private readonly inner = new Int32Array(8);
  private readonly outer = new Int32Array(8);
  private readonly u = new Int32Array(8);
  private readonly t = new Int32Array(8);
  private readonly tmp = new Int32Array(8);
  private readonly keyBlock = new Uint8Array(64);

  /** The HMAC pad states for `key`: SHA-256 after (key ⊕ ipad) and after (key ⊕ opad). */
  private setKey(key: Uint8Array): void {
    const k = key.length > 64 ? sha256(key) : key;
    for (const [pad, state] of [
      [0x36, this.inner],
      [0x5c, this.outer],
    ] as const) {
      this.keyBlock.fill(pad);
      for (let i = 0; i < k.length; i += 1) this.keyBlock[i] = k[i]! ^ pad;
      loadBlock(this.w, this.keyBlock, 0);
      compress(IV, this.w, state);
    }
  }

  derive(password: Uint8Array, salt: Uint8Array, iterations: number, keyLength: number): Uint8Array {
    this.setKey(password);
    const out = new Uint8Array(keyLength);
    const blocks = Math.ceil(keyLength / 32);
    const first = new Uint8Array(salt.length + 4);
    first.set(salt);
    const w = this.w;
    for (let block = 1; block <= blocks; block += 1) {
      new DataView(first.buffer).setUint32(salt.length, block);
      // U1 = HMAC(password, salt ‖ INT(block))
      finish(this.inner, 64, first, w, this.tmp);
      finish(this.outer, 64, wordsToBytes(this.tmp, 32), w, this.u);
      this.t.set(this.u);
      // U2…Uc: the message is the previous 32-byte U — one fixed-padding
      // block (0x80, zeros, bit length (64 + 32) × 8 = 768).
      for (let round = 1; round < iterations; round += 1) {
        for (let i = 0; i < 8; i += 1) w[i] = this.u[i]!;
        w[8] = 0x80000000 | 0;
        w[9] = 0;
        w[10] = 0;
        w[11] = 0;
        w[12] = 0;
        w[13] = 0;
        w[14] = 0;
        w[15] = 768;
        compress(this.inner, w, this.tmp);
        for (let i = 0; i < 8; i += 1) w[i] = this.tmp[i]!;
        compress(this.outer, w, this.u);
        for (let i = 0; i < 8; i += 1) this.t[i] = this.t[i]! ^ this.u[i]!;
      }
      const offset = (block - 1) * 32;
      wordsToBytes(this.t, Math.min(32, keyLength - offset), out, offset);
    }
    return out;
  }
}

/** PBKDF2-HMAC-SHA256 (RFC 8018). */
export function pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, iterations: number, keyLength: number): Uint8Array {
  return new Pbkdf2().derive(password, salt, iterations, keyLength);
}

// ---------------------------------------------------------------------------
// The challenge
// ---------------------------------------------------------------------------

const HEX = /^(?:[0-9a-f]{2})*$/i;

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** A v2 challenge this solver can work on (the shape `GET /api/auth/captcha/challenge` returns). */
export function isSolvableChallenge(raw: unknown): raw is AltchaV2Challenge {
  if (typeof raw !== 'object' || raw === null) return false;
  const parameters = (raw as { parameters?: unknown }).parameters;
  if (typeof parameters !== 'object' || parameters === null) return false;
  const p = parameters as Record<string, unknown>;
  return (
    typeof p.algorithm === 'string' &&
    (FALLBACK_ALGORITHMS as readonly string[]).includes(p.algorithm) &&
    typeof p.nonce === 'string' &&
    HEX.test(p.nonce) &&
    typeof p.salt === 'string' &&
    HEX.test(p.salt) &&
    typeof p.keyPrefix === 'string' &&
    /^[0-9a-f]+$/i.test(p.keyPrefix) &&
    Number.isSafeInteger(p.cost) &&
    (p.cost as number) >= 1 &&
    Number.isSafeInteger(p.keyLength) &&
    (p.keyLength as number) >= 1 &&
    (p.keyLength as number) <= (p.algorithm === 'SHA-256' ? 32 : 1024)
  );
}

/** Tries counters for one challenge; reuses its buffers between attempts. */
export function createSolver(challenge: AltchaV2Challenge) {
  const { algorithm, cost, keyLength, keyPrefix } = challenge.parameters;
  const nonce = hexToBytes(challenge.parameters.nonce);
  const salt = hexToBytes(challenge.parameters.salt);
  const prefixBytes = keyPrefix.length % 2 === 0 ? hexToBytes(keyPrefix) : null;
  const password = new Uint8Array(nonce.length + 4);
  password.set(nonce);
  const passwordView = new DataView(password.buffer);
  const pbkdf2 = new Pbkdf2();

  const derive = (): Uint8Array => {
    if (algorithm === 'SHA-256') {
      // As altcha-lib verifies it (algorithms/sha.js): round 1 over
      // salt ‖ password, each next round over the previous full digest,
      // cut to keyLength at the end.
      let digest: Uint8Array = new Uint8Array(salt.length + password.length);
      digest.set(salt);
      digest.set(password, salt.length);
      for (let round = 0; round < Math.max(1, cost); round += 1) digest = sha256(digest);
      return digest.slice(0, keyLength);
    }
    return pbkdf2.derive(password, salt, cost, keyLength);
  };

  const matches = (key: Uint8Array): boolean => {
    if (prefixBytes) {
      if (prefixBytes.length > key.length) return false;
      for (let i = 0; i < prefixBytes.length; i += 1) if (key[i] !== prefixBytes[i]) return false;
      return true;
    }
    return bytesToHex(key).startsWith(keyPrefix.toLowerCase());
  };

  /** The derived key for `counter` when it solves the challenge, else null. */
  return (counter: number): string | null => {
    passwordView.setUint32(nonce.length, counter >>> 0);
    const key = derive();
    return matches(key) ? bytesToHex(key) : null;
  };
}

/**
 * Search counters `start, start + step, …` until one solves the challenge
 * or `deadline` (a `performance.now()` time) passes. Synchronous: run it in
 * a worker, which is terminated to stop it early.
 */
export function solveRange(
  challenge: AltchaV2Challenge,
  { start = 0, step = 1, deadline = Infinity }: { start?: number; step?: number; deadline?: number } = {}
): AltchaSolution | null {
  const attempt = createSolver(challenge);
  const began = performance.now();
  for (let counter = start, tries = 0; counter <= 0xffffffff; counter += step, tries += 1) {
    if (tries % 16 === 0 && performance.now() > deadline) return null;
    const derivedKey = attempt(counter);
    if (derivedKey) return { counter, derivedKey, time: Math.round((performance.now() - began) * 10) / 10 };
  }
  return null;
}

/**
 * The token the protected routes take: base64 of the UTF-8 JSON
 * `{ challenge: { parameters, signature }, solution }` — exactly what the
 * ALTCHA widget submits for a v2 challenge.
 */
export function altchaPayload(challenge: AltchaV2Challenge, solution: AltchaSolution): string {
  const json = JSON.stringify({
    challenge: { parameters: challenge.parameters, signature: challenge.signature },
    solution,
  });
  let binary = '';
  for (const byte of new TextEncoder().encode(json)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
