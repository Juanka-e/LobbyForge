/**
 * One-time codes for the desktop session handoff (DP-07, see
 * `app/api/auth/desktop-session/route.ts`). Shared by the mint route, the
 * completion route and the password route.
 *
 * security-review AUTH-001: a code used to carry only `{userId, state}`,
 * so one minted before a password change still opened a fresh, unrevoked
 * session after it — the attacker with the old password simply kept a
 * code in hand. Two independent guards close that:
 *   1. every record carries a fingerprint of the password hash it was
 *      minted under, and completion refuses a record whose fingerprint
 *      no longer matches the account (this also covers a mint racing the
 *      password change);
 *   2. a per-user set indexes the outstanding codes, so the password
 *      route can delete them outright.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { redis } from '@/lib/redis';

export const DESKTOP_HANDOFF_TTL_SECONDS = 300;

export interface DesktopHandoffRecord {
  userId: string;
  state: string;
  used: boolean;
  /** sha256 (hex) of the password hash at mint time — never the hash itself. */
  credential: string;
}

/** The URL-safe alphabet `randomBytes(..).toString('base64url')` produces. */
const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isDesktopHandoffCodeShape(code: string): boolean {
  return CODE_PATTERN.test(code);
}

function codeKey(code: string): string {
  return `lf:desktop-handoff:${code}`;
}

function userCodesKey(userId: string): string {
  return `lf:desktop-handoff:user:${userId}`;
}

export function credentialFingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex');
}

/** Constant-time check that the account still has the credential the code was minted under. */
export function credentialMatches(record: Pick<DesktopHandoffRecord, 'credential'>, passwordHash: string | null | undefined): boolean {
  if (!passwordHash || typeof record.credential !== 'string') return false;
  const expected = Buffer.from(credentialFingerprint(passwordHash), 'hex');
  const stored = Buffer.from(record.credential, 'hex');
  return stored.length === expected.length && timingSafeEqual(stored, expected);
}

export async function storeDesktopHandoffCode(code: string, record: DesktopHandoffRecord): Promise<void> {
  // Index first: a code that exists must always be findable by the
  // password route. Each mint refreshes the set's TTL, so the set lives
  // at least as long as the newest code in it.
  const indexKey = userCodesKey(record.userId);
  await redis.sadd(indexKey, code);
  await redis.expire(indexKey, DESKTOP_HANDOFF_TTL_SECONDS);
  await redis.set(codeKey(code), JSON.stringify(record), 'EX', DESKTOP_HANDOFF_TTL_SECONDS);
}

/**
 * Burn a code and return its record (null when unknown, expired or
 * malformed). LF-SEC-008: GETDEL — the read and the delete are ONE
 * atomic operation, so two parallel completions can never both see it.
 */
export async function takeDesktopHandoffCode(code: string): Promise<DesktopHandoffRecord | null> {
  const raw = await redis.getdel(codeKey(code));
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as Partial<DesktopHandoffRecord> | null;
    if (!record || typeof record.userId !== 'string' || typeof record.state !== 'string') return null;
    return {
      userId: record.userId,
      state: record.state,
      used: record.used === true,
      credential: typeof record.credential === 'string' ? record.credential : '',
    };
  } catch {
    return null;
  }
}

/** Delete every outstanding handoff code of a user. Returns how many were indexed. */
export async function revokeDesktopHandoffCodes(userId: string): Promise<number> {
  const indexKey = userCodesKey(userId);
  const codes = (await redis.smembers(indexKey)).filter(isDesktopHandoffCodeShape);
  await redis.del(indexKey, ...codes.map(codeKey));
  return codes.length;
}
