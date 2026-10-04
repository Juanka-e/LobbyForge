/**
 * Bot token checks for `/ws/bot` — the gateway twin of the web app's
 * `apps/web/lib/bots/token.ts` (same format, same domain-separated
 * `sha256$<hex>` hash, same constant-time comparison). A test pins the two
 * hash functions to each other, so a token the REST API accepts is a token
 * the gateway accepts, and nothing else.
 *
 *   lfb_<bot id: 32 hex>_<secret: 43 base64url>
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const BOT_TOKEN_PATTERN = /^lfb_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;
const HASH_PREFIX = 'sha256$';
const HASH_CONTEXT = 'lobbyforge:bot-token:v1\n';
const MAX_AUTHORIZATION_LENGTH = 256;

export function hashBotToken(token: string): string {
  return `${HASH_PREFIX}${createHash('sha256').update(HASH_CONTEXT).update(token, 'utf8').digest('hex')}`;
}

/** Hash compared against when the claimed bot has no row or no token — every path hashes + compares. */
export const ABSENT_BOT_HASH = hashBotToken('lfb_absent');

/** The bot a well-formed token CLAIMS to be — not proof; call `verifyBotToken`. */
export function parseBotToken(token: string): { botId: string } | null {
  const match = BOT_TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const c = match[1]!;
  return { botId: `${c.slice(0, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}-${c.slice(16, 20)}-${c.slice(20)}` };
}

/** Constant-time check of a presented token against the stored hash. */
export function verifyBotToken(token: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !storedHash.startsWith(HASH_PREFIX)) return false;
  const expected = Buffer.from(storedHash.slice(HASH_PREFIX.length), 'hex');
  const actual = Buffer.from(hashBotToken(token).slice(HASH_PREFIX.length), 'hex');
  if (expected.length !== 32 || actual.length !== 32) return false;
  return timingSafeEqual(expected, actual);
}

/** `Authorization: Bot <token>` → the token (scheme case-insensitive); anything else → null. */
export function readBotAuthorization(header: string | string[] | null | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value.length > MAX_AUTHORIZATION_LENGTH) return null;
  const match = /^Bot +([^\s]+)\s*$/i.exec(value.trim());
  return match ? match[1]! : null;
}
