/**
 * The built-in provider: ALTCHA proof of work (docs/CAPTCHA.md §4.2, §5),
 * with `altcha-lib` 2.x and its v2 challenge format — the native format of
 * the `altcha` 3.x widget.
 *
 * - Algorithm PBKDF2/SHA-256 (WebCrypto in the browser, no WASM), in the
 *   library's deterministic mode: the server picks the counter, signs the
 *   expected derived key (`keySignature`), and verifying is two HMACs — no
 *   key derivation on the server for a submitted solution.
 * - The challenge is HMAC-signed with a key derived from the session secret
 *   (info "lobbyforge:altcha:v1"; the key signature uses
 *   "lobbyforge:altcha:key:v1"). The signed parameters carry the expiry
 *   (`expiresAt`, 5 minutes) and the surface (`data.surface`), so a solution
 *   for `guest` is refused on `register`, and an old one is refused anywhere.
 * - Replay: one use per challenge. The marker is a Redis `SET NX` keyed by
 *   sha256 of the challenge signature (which the HMAC makes unique and
 *   unforgeable; a re-encoded copy of the same token hashes the same), with
 *   a TTL equal to the challenge's remaining lifetime. Without Redis in
 *   production the answer is `unavailable` (fail closed).
 */
import { createHash, randomInt } from 'node:crypto';
import { createChallenge, verifySolution, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { z } from 'zod';
import { ALTCHA_KEY_SIGNATURE_INFO, ALTCHA_SIGNATURE_INFO, deriveCaptchaKey } from './keys';
import { captchaKey, captchaStoreUsesRedis, memorySetNx, storeSetNx } from './store';
import type { AltchaDifficulty, CaptchaSurface, CaptchaVerdict } from './types';
import { CAPTCHA_TOKEN_MAX_LENGTH, isCaptchaSurface } from './types';

export const ALTCHA_ALGORITHM = 'PBKDF2/SHA-256';
export const ALTCHA_CHALLENGE_TTL_SECONDS = 5 * 60;

/**
 * Work per difficulty. The browser derives a key (PBKDF2 with `cost`
 * iterations) for every counter value from 0 up to the secret one, spread
 * over the widget's workers; the server picks that counter uniformly in
 * [0, counterMax]. Expected work = cost × counterMax / 2 PBKDF2 iterations,
 * worst case cost × counterMax:
 *   - normal: 2 000 × 0–2 500 → 2.5 M expected, 5 M at most (well under a
 *     second on a desktop with Web Crypto);
 *   - hard:   4 000 × 0–7 500 → 15 M expected, 30 M at most (~6× normal).
 * The range starts at 0 on purpose: a public floor (the counter is never
 * below N) would let a solver skip the first N derivations for free; the
 * higher cost keeps the expected work where the floor-based range had it.
 */
export const ALTCHA_DIFFICULTY: Record<AltchaDifficulty, { cost: number; counterMin: number; counterMax: number }> = {
  normal: { cost: 2_000, counterMin: 0, counterMax: 2_500 },
  hard: { cost: 4_000, counterMin: 0, counterMax: 7_500 },
};

function signatureSecret(): string {
  return deriveCaptchaKey(ALTCHA_SIGNATURE_INFO).toString('hex');
}

function keySignatureSecret(): string {
  return deriveCaptchaKey(ALTCHA_KEY_SIGNATURE_INFO).toString('hex');
}

/** A signed challenge for one surface. Throws MissingSessionSecretError without a session secret. */
export async function createAltchaChallenge(
  surface: CaptchaSurface,
  difficulty: AltchaDifficulty = 'normal',
  now: number = Date.now()
): Promise<Challenge> {
  const work = ALTCHA_DIFFICULTY[difficulty] ?? ALTCHA_DIFFICULTY.normal;
  return createChallenge({
    algorithm: ALTCHA_ALGORITHM,
    cost: work.cost,
    counter: randomInt(work.counterMin, work.counterMax + 1),
    deriveKey,
    data: { surface },
    expiresAt: Math.floor(now / 1000) + ALTCHA_CHALLENGE_TTL_SECONDS,
    hmacSignatureSecret: signatureSecret(),
    hmacKeySignatureSecret: keySignatureSecret(),
  });
}

const HEX = /^[0-9a-f]+$/i;

const PayloadSchema = z.object({
  challenge: z.object({
    parameters: z
      .object({
        algorithm: z.string().max(32),
        nonce: z.string().max(128).regex(HEX),
        salt: z.string().max(128).regex(HEX),
        cost: z.number().int().positive(),
        keyLength: z.number().int().positive().max(64),
        keyPrefix: z.string().max(128).regex(HEX),
        keySignature: z.string().max(256).regex(HEX).optional(),
        expiresAt: z.number().int().positive().optional(),
        data: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      })
      .passthrough(),
    signature: z.string().min(1).max(256).regex(HEX),
  }),
  solution: z.object({
    counter: z.number().int().nonnegative(),
    derivedKey: z.string().min(1).max(256).regex(HEX),
    time: z.number().optional(),
  }),
});

type AltchaPayload = z.infer<typeof PayloadSchema>;

/** The widget's payload: base64 of `{ challenge: { parameters, signature }, solution }`. */
export function parseAltchaPayload(token: string): AltchaPayload | null {
  if (!token || token.length > CAPTCHA_TOKEN_MAX_LENGTH) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = PayloadSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

function replayKey(signature: string): string {
  return captchaKey(`altcha-used:${createHash('sha256').update(signature.toLowerCase()).digest('hex')}`);
}

/**
 * Check an ALTCHA payload for `surface`: signature, solution, expiry,
 * surface, then burn it (replay). Throws MissingSessionSecretError when no
 * session secret is configured (the caller answers `misconfigured`).
 */
export async function verifyAltchaToken(
  token: string,
  surface: CaptchaSurface,
  now: number = Date.now()
): Promise<CaptchaVerdict> {
  const payload = parseAltchaPayload(token);
  if (!payload) return 'invalid';
  const { parameters } = payload.challenge;
  if (parameters.algorithm !== ALTCHA_ALGORITHM) return 'invalid';
  // Every challenge this server signs carries an expiry and a key signature.
  if (!parameters.expiresAt || !parameters.keySignature) return 'invalid';

  const hmacSignatureSecret = signatureSecret();
  const hmacKeySignatureSecret = keySignatureSecret();
  let result: Awaited<ReturnType<typeof verifySolution>>;
  try {
    result = await verifySolution({
      challenge: payload.challenge as Challenge,
      solution: payload.solution,
      deriveKey,
      hmacSignatureSecret,
      hmacKeySignatureSecret,
    });
  } catch {
    // e.g. an odd-length hex string the library cannot decode.
    return 'invalid';
  }
  if (result.expired) return 'expired';
  if (!result.verified) return 'invalid';
  // Checked against the SIGNED parameters (the signature passed above).
  const signedSurface = parameters.data?.surface;
  if (!isCaptchaSurface(signedSurface) || signedSurface !== surface) return 'invalid';
  const remainingMs = parameters.expiresAt * 1000 - now;
  if (remainingMs <= 0) return 'expired';
  if (remainingMs > (ALTCHA_CHALLENGE_TTL_SECONDS + 60) * 1000) return 'invalid';

  const key = replayKey(payload.challenge.signature);
  try {
    return (await storeSetNx(key, '1', remainingMs)) ? 'ok' : 'duplicate';
  } catch (error) {
    console.error('[captcha] ALTCHA replay store unavailable', (error as Error).message);
    // Production fails closed: without the marker, one solved challenge
    // could be replayed for its whole lifetime.
    if (process.env.NODE_ENV === 'production' && captchaStoreUsesRedis()) return 'unavailable';
    return memorySetNx(key, '1', remainingMs) ? 'ok' : 'duplicate';
  }
}
