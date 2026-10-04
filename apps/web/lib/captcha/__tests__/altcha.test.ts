/**
 * The built-in ALTCHA provider (docs/CAPTCHA.md §4.2, §5): a full round
 * trip with altcha-lib's own solver, and every way a token is refused —
 * replay, expiry, another surface, tampering, the widget's test payload —
 * plus the production replay store (Redis) failing closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';

const redisSet = vi.fn();
vi.mock('@/lib/redis', () => ({ redis: { set: (...args: unknown[]) => redisSet(...args) } }));

import {
  ALTCHA_ALGORITHM,
  ALTCHA_CHALLENGE_TTL_SECONDS,
  ALTCHA_DIFFICULTY,
  createAltchaChallenge,
  parseAltchaPayload,
  verifyAltchaToken,
} from '../altcha';
import { resetCaptchaMemoryForTests } from '../store';

const SECRET = 's'.repeat(48);
const REAL_DIFFICULTY = structuredClone(ALTCHA_DIFFICULTY);

async function solve(challenge: Challenge): Promise<string> {
  const solution = await solveChallenge({ challenge, deriveKey, timeout: 60_000 });
  if (!solution) throw new Error('no solution');
  // Exactly what the altcha 3.x widget submits.
  return Buffer.from(JSON.stringify({ challenge: { parameters: challenge.parameters, signature: challenge.signature }, solution })).toString('base64');
}

function cheap(): void {
  // Same algorithm and code path, a fraction of the work — keeps the suite fast.
  ALTCHA_DIFFICULTY.normal = { cost: 10, counterMin: 5, counterMax: 40 };
}

function reencode(token: string, edit: (payload: { challenge: Challenge; solution: Record<string, unknown> }) => void): string {
  const payload = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  edit(payload);
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  vi.stubEnv('LOBBYFORGE_RATE_LIMIT_STORE', '');
  resetCaptchaMemoryForTests();
  redisSet.mockReset();
});

afterEach(() => {
  ALTCHA_DIFFICULTY.normal = { ...REAL_DIFFICULTY.normal };
  ALTCHA_DIFFICULTY.hard = { ...REAL_DIFFICULTY.hard };
  vi.unstubAllEnvs();
});

describe('ALTCHA challenge', () => {
  it('is an altcha-lib v2 challenge, signed, with the surface and a 5-minute expiry in the signed parameters', async () => {
    const now = Date.UTC(2026, 9, 4, 12, 0, 0);
    const challenge = await createAltchaChallenge('register', 'normal', now);
    expect(Object.keys(challenge).sort()).toEqual(['parameters', 'signature']);
    expect(challenge.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(challenge.parameters).toMatchObject({
      algorithm: ALTCHA_ALGORITHM,
      cost: REAL_DIFFICULTY.normal.cost,
      data: { surface: 'register' },
      expiresAt: Math.floor(now / 1000) + ALTCHA_CHALLENGE_TTL_SECONDS,
    });
    // Deterministic mode: the expected key is signed, so verifying needs no key derivation.
    expect(challenge.parameters.keySignature).toMatch(/^[0-9a-f]{64}$/);
    expect(challenge.parameters.keyPrefix).toMatch(/^[0-9a-f]{32}$/);
  });

  it('counters start at 0 (no public floor to skip); hard costs about 6× the expected work of normal', async () => {
    const hard = await createAltchaChallenge('guest', 'hard');
    expect(hard.parameters.cost).toBe(REAL_DIFFICULTY.hard.cost);
    expect(REAL_DIFFICULTY.normal.counterMin).toBe(0);
    expect(REAL_DIFFICULTY.hard.counterMin).toBe(0);
    const expected = (d: { cost: number; counterMax: number }) => (d.cost * d.counterMax) / 2;
    // The numbers the docs (and the UI's pure-JS fallback solver) are built on.
    expect(expected(REAL_DIFFICULTY.normal)).toBe(2_500_000);
    expect(expected(REAL_DIFFICULTY.hard)).toBe(15_000_000);
  });

  it('needs a session secret', async () => {
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'short');
    await expect(createAltchaChallenge('register')).rejects.toThrow(/LOBBYFORGE_SESSION_SECRET/);
  });
});

describe('ALTCHA verification', () => {
  it('round trip at the real normal difficulty: solved with altcha-lib, accepted once', async () => {
    const token = await solve(await createAltchaChallenge('register', 'normal'));
    expect(await verifyAltchaToken(token, 'register')).toBe('ok');
    expect(await verifyAltchaToken(token, 'register')).toBe('duplicate');
  }, 30_000);

  it('a re-encoded copy of a used token is still a replay', async () => {
    cheap();
    const token = await solve(await createAltchaChallenge('guest'));
    expect(await verifyAltchaToken(token, 'guest')).toBe('ok');
    const reordered = reencode(token, (payload) => {
      payload.solution = { time: 1, ...payload.solution };
    });
    expect(reordered).not.toBe(token);
    expect(await verifyAltchaToken(reordered, 'guest')).toBe('duplicate');
  });

  it('refuses a solution for another surface', async () => {
    cheap();
    const token = await solve(await createAltchaChallenge('guest'));
    expect(await verifyAltchaToken(token, 'register')).toBe('invalid');
    // …and the refusal did not burn it for its own surface.
    expect(await verifyAltchaToken(token, 'guest')).toBe('ok');
  });

  it('refuses an expired challenge', async () => {
    cheap();
    const sixMinutesAgo = Date.now() - 6 * 60_000;
    const token = await solve(await createAltchaChallenge('login', 'normal', sixMinutesAgo));
    expect(await verifyAltchaToken(token, 'login')).toBe('expired');
  });

  it('refuses tampering: a moved surface, a stretched expiry, a wrong key, a forged signature', async () => {
    cheap();
    const token = await solve(await createAltchaChallenge('guest'));
    const moved = reencode(token, (p) => {
      p.challenge.parameters.data = { surface: 'register' };
    });
    expect(await verifyAltchaToken(moved, 'register')).toBe('invalid');
    const stretched = reencode(token, (p) => {
      p.challenge.parameters.expiresAt = (p.challenge.parameters.expiresAt ?? 0) + 3600;
    });
    expect(await verifyAltchaToken(stretched, 'guest')).toBe('invalid');
    const wrongKey = reencode(token, (p) => {
      p.solution.derivedKey = '00'.repeat(32);
    });
    expect(await verifyAltchaToken(wrongKey, 'guest')).toBe('invalid');
    const forged = reencode(token, (p) => {
      p.challenge.signature = 'ab'.repeat(32);
    });
    expect(await verifyAltchaToken(forged, 'guest')).toBe('invalid');
    // The original is untouched by all of that.
    expect(await verifyAltchaToken(token, 'guest')).toBe('ok');
  });

  it('refuses a challenge signed under another session secret', async () => {
    cheap();
    const token = await solve(await createAltchaChallenge('register'));
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 't'.repeat(48));
    expect(await verifyAltchaToken(token, 'register')).toBe('invalid');
  });

  it('refuses garbage, the widget’s test-mode payload and other algorithms', async () => {
    expect(await verifyAltchaToken('not base64 json', 'register')).toBe('invalid');
    expect(await verifyAltchaToken(Buffer.from('{"x":1}').toString('base64'), 'register')).toBe('invalid');
    const testMode = Buffer.from(JSON.stringify({ challenge: null, solution: null, test: true })).toString('base64');
    expect(await verifyAltchaToken(testMode, 'register')).toBe('invalid');
    expect(parseAltchaPayload('x'.repeat(5000))).toBeNull();
    cheap();
    const token = await solve(await createAltchaChallenge('register'));
    const sha = reencode(token, (p) => {
      p.challenge.parameters.algorithm = 'SHA-256';
    });
    expect(await verifyAltchaToken(sha, 'register')).toBe('invalid');
    const odd = reencode(token, (p) => {
      p.solution.derivedKey = 'abc';
    });
    expect(await verifyAltchaToken(odd, 'register')).toBe('invalid');
  });

  it('production: the replay marker is a Redis SET NX with the remaining lifetime as TTL', async () => {
    cheap();
    const token = await solve(await createAltchaChallenge('register'));
    vi.stubEnv('NODE_ENV', 'production');
    redisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    expect(await verifyAltchaToken(token, 'register')).toBe('ok');
    expect(await verifyAltchaToken(token, 'register')).toBe('duplicate');
    const [key, value, px, ttl, nx] = redisSet.mock.calls[0]!;
    expect(key).toMatch(/^lf:production:captcha:altcha-used:[0-9a-f]{64}$/);
    expect([value, px, nx]).toEqual(['1', 'PX', 'NX']);
    expect(ttl).toBeGreaterThan(290_000);
    expect(ttl).toBeLessThanOrEqual(300_000);
  });

  it('production: without Redis the token is refused (unavailable), never accepted unchecked', async () => {
    cheap();
    const token = await solve(await createAltchaChallenge('guest'));
    vi.stubEnv('NODE_ENV', 'production');
    redisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await verifyAltchaToken(token, 'guest')).toBe('unavailable');
  });
});
