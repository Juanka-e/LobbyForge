/**
 * Proof-of-address challenges (docs/EMAIL.md §3.1, §4.1): one email
 * carries a 6-digit code AND a link token.
 *
 *   - link token: 32 random bytes, base64url in the link; stored as
 *     sha256(bytes). Valid 24 h (verify, change) or 60 min (reset).
 *   - code: 6 digits, valid 15 minutes, at most 5 wrong attempts; stored as
 *     HMAC-SHA256(key, `<row id>:<code>`), key = HKDF(session secret,
 *     "lobbyforge:email-code:v1"). Mixing the row id in means two
 *     challenges with the same code never share a hash.
 *   - a new send replaces the live challenge of that purpose;
 *   - comparisons use `timingSafeEqual`; consuming is the database's one
 *     conditional UPDATE (`packages/db/src/queries/email.ts`).
 *
 * Server-only.
 */
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  deleteStaleEmailTokens,
  getActiveEmailToken,
  getEmailTokenByHash,
  reserveEmailCodeAttempt,
  replaceEmailToken,
  type EmailTokenPurpose,
  type EmailTokenRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { deriveSessionKey } from '@/lib/secret-box';

export const CODE_KEY_INFO = 'lobbyforge:email-code:v1';
export const CODE_TTL_MS = 15 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
export const LINK_TTL_MS: Record<EmailTokenPurpose, number> = {
  verify: 24 * 60 * 60_000,
  change: 24 * 60 * 60_000,
  reset: 60 * 60_000,
};
const CLEANUP_INTERVAL_MS = 60 * 60_000;
const CLEANUP_KEY = '__lobbyforgeEmailTokenCleanup__';

export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function generateLinkToken(): { token: string; hash: Buffer } {
  const raw = randomBytes(32);
  return { token: raw.toString('base64url'), hash: createHash('sha256').update(raw).digest() };
}

/** The stored hash of a link token, or null when the token is not 32 base64url bytes. */
export function hashLinkToken(token: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== 32) return null;
  return createHash('sha256').update(raw).digest();
}

export function hashCode(tokenId: string, code: string): Buffer {
  return createHmac('sha256', deriveSessionKey(CODE_KEY_INFO)).update(`${tokenId}:${code}`).digest();
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function codeMatches(row: Pick<EmailTokenRow, 'id' | 'codeHash'>, code: string): boolean {
  return sameBytes(hashCode(row.id, code), Buffer.from(row.codeHash));
}

/** Drop expired and consumed challenges at most once an hour per process (never throws). */
function maybeCleanup(): void {
  const g = globalThis as unknown as Record<string, number | undefined>;
  const now = Date.now();
  if ((g[CLEANUP_KEY] ?? 0) > now - CLEANUP_INTERVAL_MS) return;
  g[CLEANUP_KEY] = now;
  void deleteStaleEmailTokens(getDb(), new Date(now - 24 * 60 * 60_000)).catch((error: unknown) => {
    console.error('[mail] token cleanup failed', JSON.stringify((error as Error).message));
  });
}

export interface IssuedChallenge {
  id: string;
  token: string;
  code: string;
  expiresAt: Date;
  codeExpiresAt: Date;
}

/** Create the challenge for (user, purpose), replacing the live one. */
export async function issueChallenge(input: { userId: string; purpose: EmailTokenPurpose; targetEmail: string; now?: Date }): Promise<IssuedChallenge> {
  const now = input.now?.getTime() ?? Date.now();
  const id = randomUUID();
  const code = generateCode();
  const { token, hash } = generateLinkToken();
  const expiresAt = new Date(now + LINK_TTL_MS[input.purpose]);
  const codeExpiresAt = new Date(now + Math.min(CODE_TTL_MS, LINK_TTL_MS[input.purpose]));
  await replaceEmailToken(getDb(), {
    id,
    userId: input.userId,
    purpose: input.purpose,
    targetEmail: input.targetEmail,
    tokenHash: hash,
    codeHash: hashCode(id, code),
    expiresAt,
    codeExpiresAt,
  });
  maybeCleanup();
  return { id, token, code, expiresAt, codeExpiresAt };
}

export type CodeCheck =
  | { ok: true; row: EmailTokenRow }
  | { ok: false; error: 'invalid_code' | 'expired' | 'too_many_attempts' };

/**
 * Check a code against the live challenge of (user, purpose). Every
 * submission first RESERVES an attempt in the database (one conditional
 * UPDATE: under the cap, code window open, not consumed) and only then
 * compares — so however many guesses arrive at once, at most
 * MAX_CODE_ATTEMPTS are ever compared. The submission that uses the last
 * attempt with a wrong code answers `too_many_attempts`, and the code is
 * dead (the link still works). On success the caller consumes with the
 * reserved attempt (the consuming UPDATE allows a count AT the cap).
 */
export async function checkCode(userId: string, purpose: EmailTokenPurpose, code: string, now = new Date()): Promise<CodeCheck> {
  const row = await getActiveEmailToken(getDb(), userId, purpose);
  if (!row) return { ok: false, error: 'invalid_code' };
  if (row.codeAttempts >= MAX_CODE_ATTEMPTS) return { ok: false, error: 'too_many_attempts' };
  if (row.codeExpiresAt.getTime() <= now.getTime() || row.expiresAt.getTime() <= now.getTime()) return { ok: false, error: 'expired' };
  const reserved = await reserveEmailCodeAttempt(getDb(), row.id, MAX_CODE_ATTEMPTS);
  if (!reserved) {
    // Lost a race (another guess took the last attempt, the challenge was
    // consumed or replaced, or the window closed): say which.
    const fresh = await getActiveEmailToken(getDb(), userId, purpose);
    if (!fresh || fresh.id !== row.id) return { ok: false, error: 'invalid_code' };
    if (fresh.codeAttempts >= MAX_CODE_ATTEMPTS) return { ok: false, error: 'too_many_attempts' };
    return { ok: false, error: 'expired' };
  }
  if (!codeMatches(reserved, code)) {
    return { ok: false, error: reserved.codeAttempts >= MAX_CODE_ATTEMPTS ? 'too_many_attempts' : 'invalid_code' };
  }
  return { ok: true, row: reserved };
}

export type TokenCheck = { ok: true; row: EmailTokenRow } | { ok: false; error: 'invalid_token' | 'expired' };

/** Find the challenge a link token belongs to (of this purpose, not consumed, not expired). */
export async function checkLinkToken(token: string, purpose: EmailTokenPurpose, now = new Date()): Promise<TokenCheck> {
  const hash = hashLinkToken(token);
  if (!hash) return { ok: false, error: 'invalid_token' };
  const row = await getEmailTokenByHash(getDb(), hash);
  if (!row || row.purpose !== purpose || row.consumedAt || !sameBytes(Buffer.from(row.tokenHash), hash)) {
    return { ok: false, error: 'invalid_token' };
  }
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, error: 'expired' };
  return { ok: true, row };
}
