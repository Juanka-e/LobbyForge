import { describe, expect, it } from 'vitest';
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { createChallenge, verifySolution } from 'altcha-lib';
import { deriveKey as pbkdf2DeriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { deriveKey as shaDeriveKey } from 'altcha-lib/algorithms/sha';
import {
  altchaPayload,
  isSolvableChallenge,
  pbkdf2Sha256,
  sha256,
  solveRange,
  type AltchaV2Challenge,
} from '../altcha-fallback-solver';

const SECRET = 'test-hmac-secret';
const KEY_SECRET = 'test-key-secret';

/** What the server does with a token: decode it, then altcha-lib's verifySolution. */
async function verifyToken(token: string, deriveKey: typeof pbkdf2DeriveKey, keySignatureSecret?: string) {
  const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  return verifySolution({
    challenge: decoded.challenge,
    solution: decoded.solution,
    deriveKey,
    hmacSignatureSecret: SECRET,
    ...(keySignatureSecret ? { hmacKeySignatureSecret: keySignatureSecret } : {}),
  });
}

describe('the pure-JS ALTCHA solver (plain-HTTP pages)', { timeout: 30_000 }, () => {
  it('computes SHA-256 like node:crypto, across block boundaries', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = randomBytes(length);
      expect(Buffer.from(sha256(data)).toString('hex')).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });

  it('computes PBKDF2-HMAC-SHA256 like node:crypto', () => {
    const cases: Array<[number, number, number, number]> = [
      // [password bytes, salt bytes, iterations, key length]
      [20, 16, 1, 32],
      [20, 16, 2, 32],
      [20, 16, 1000, 32],
      [20, 16, 3, 16],
      [20, 16, 3, 64],
      [70, 60, 5, 40],
    ];
    for (const [passwordLength, saltLength, iterations, keyLength] of cases) {
      const password = randomBytes(passwordLength);
      const salt = randomBytes(saltLength);
      expect(Buffer.from(pbkdf2Sha256(password, salt, iterations, keyLength)).toString('hex')).toBe(
        pbkdf2Sync(password, salt, iterations, keyLength, 'sha256').toString('hex')
      );
    }
  });

  it('solves a server-style PBKDF2 challenge (signed, key signature, surface, expiry) and passes verifySolution', async () => {
    const challenge = (await createChallenge({
      algorithm: 'PBKDF2/SHA-256',
      cost: 300,
      counter: 37,
      deriveKey: pbkdf2DeriveKey,
      data: { surface: 'guest' },
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      hmacSignatureSecret: SECRET,
      hmacKeySignatureSecret: KEY_SECRET,
    })) as AltchaV2Challenge;
    expect(isSolvableChallenge(challenge)).toBe(true);
    const solution = solveRange(challenge);
    expect(solution?.counter).toBe(37);
    const token = altchaPayload(challenge, solution!);
    await expect(verifyToken(token, pbkdf2DeriveKey, KEY_SECRET)).resolves.toMatchObject({ verified: true });
    // …and on the re-derive path (no key signature secret) as well.
    await expect(verifyToken(token, pbkdf2DeriveKey)).resolves.toMatchObject({ verified: true });
  });

  it('reads the parameters from the challenge: a range that starts at 0 and another cost', async () => {
    for (const [counter, cost] of [
      [0, 50],
      [9, 1_500],
    ] as const) {
      const challenge = (await createChallenge({
        algorithm: 'PBKDF2/SHA-256',
        cost,
        counter,
        deriveKey: pbkdf2DeriveKey,
        hmacSignatureSecret: SECRET,
      })) as AltchaV2Challenge;
      const solution = solveRange(challenge)!;
      expect(solution.counter).toBe(counter);
      await expect(verifyToken(altchaPayload(challenge, solution), pbkdf2DeriveKey)).resolves.toMatchObject({ verified: true });
    }
  });

  it('solves an open-ended (odd-length prefix) challenge', async () => {
    const challenge = (await createChallenge({
      algorithm: 'PBKDF2/SHA-256',
      cost: 20,
      keyPrefix: 'a',
      deriveKey: pbkdf2DeriveKey,
      hmacSignatureSecret: SECRET,
    })) as AltchaV2Challenge;
    const solution = solveRange(challenge)!;
    expect(solution.derivedKey.startsWith('a')).toBe(true);
    await expect(verifyToken(altchaPayload(challenge, solution), pbkdf2DeriveKey)).resolves.toMatchObject({ verified: true });
  });

  it('solves a SHA-256 challenge the way altcha-lib verifies it', async () => {
    const challenge = (await createChallenge({
      algorithm: 'SHA-256',
      cost: 4,
      counter: 21,
      keyLength: 16,
      deriveKey: shaDeriveKey,
      hmacSignatureSecret: SECRET,
    })) as AltchaV2Challenge;
    const solution = solveRange(challenge)!;
    expect(solution.counter).toBe(21);
    await expect(verifyToken(altchaPayload(challenge, solution), shaDeriveKey)).resolves.toMatchObject({ verified: true });
  });

  it('a tampered solution does not verify', async () => {
    const challenge = (await createChallenge({
      algorithm: 'PBKDF2/SHA-256',
      cost: 10,
      counter: 3,
      deriveKey: pbkdf2DeriveKey,
      hmacSignatureSecret: SECRET,
    })) as AltchaV2Challenge;
    const solution = solveRange(challenge)!;
    const token = altchaPayload(challenge, { ...solution, counter: solution.counter + 1 });
    await expect(verifyToken(token, pbkdf2DeriveKey)).resolves.toMatchObject({ verified: false });
  });

  it('gives up at its deadline', async () => {
    const challenge = (await createChallenge({
      algorithm: 'PBKDF2/SHA-256',
      cost: 10,
      counter: 5_000_000,
      deriveKey: pbkdf2DeriveKey,
      hmacSignatureSecret: SECRET,
    })) as AltchaV2Challenge;
    expect(solveRange(challenge, { deadline: performance.now() + 50 })).toBeNull();
  });

  it('only takes challenges it can solve', () => {
    const base = { nonce: 'ab', salt: 'cd', cost: 1, keyLength: 32, keyPrefix: '00' };
    expect(isSolvableChallenge({ parameters: { ...base, algorithm: 'PBKDF2/SHA-256' } })).toBe(true);
    expect(isSolvableChallenge({ parameters: { ...base, algorithm: 'ARGON2ID' } })).toBe(false);
    expect(isSolvableChallenge({ parameters: { ...base, algorithm: 'PBKDF2/SHA-512' } })).toBe(false);
    expect(isSolvableChallenge({ parameters: { ...base, algorithm: 'SHA-256', nonce: 'xyz' } })).toBe(false);
    expect(isSolvableChallenge({ parameters: { ...base, algorithm: 'SHA-256', cost: 0 } })).toBe(false);
    expect(isSolvableChallenge({ challenge: 'v1', salt: 'x' })).toBe(false);
  });
});
