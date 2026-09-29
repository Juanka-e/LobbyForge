/**
 * Bot tokens.
 *
 *   lfb_<bot id: 32 hex, the UUID without dashes>_<secret: 32 random bytes, base64url>
 *
 * The prefix makes a leaked token recognisable (secret scanners, logs) and
 * the embedded id lets the server find the ONE row to check without a
 * table scan. The token is shown once; the database keeps
 * `sha256$<hex>` of the whole token. A 256-bit random secret cannot be
 * guessed, so a fast hash is the right tool (bcrypt/argon2 exist for
 * low-entropy passwords) — and comparison is constant-time.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const BOT_TOKEN_PREFIX = 'lfb_';
export const BOT_TOKEN_PATTERN = /^lfb_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;
const HASH_PREFIX = 'sha256$';
/** Domain separation: a bot-token hash can never equal another hash we keep. */
const HASH_CONTEXT = 'lobbyforge:bot-token:v1\n';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Longer than any real token — anything bigger is rejected unread. */
const MAX_AUTHORIZATION_LENGTH = 256;

function compactId(botId: string): string {
  if (!UUID_PATTERN.test(botId)) throw new Error('Bot id must be a UUID');
  return botId.replace(/-/g, '').toLowerCase();
}

function expandId(compact: string): string {
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function hashBotToken(token: string): string {
  return `${HASH_PREFIX}${createHash('sha256').update(HASH_CONTEXT).update(token, 'utf8').digest('hex')}`;
}

/** Mint a new token for a bot. Return the token to the admin ONCE; store only `hash`. */
export function generateBotToken(botId: string): { token: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  const token = `${BOT_TOKEN_PREFIX}${compactId(botId)}_${secret}`;
  return { token, hash: hashBotToken(token) };
}

/** The bot a well-formed token claims to be — NOT proof; call `verifyBotToken`. */
export function parseBotToken(token: string): { botId: string } | null {
  const match = BOT_TOKEN_PATTERN.exec(token);
  if (!match) return null;
  return { botId: expandId(match[1]!) };
}

/** Constant-time check of a presented token against the stored hash. */
export function verifyBotToken(token: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !storedHash.startsWith(HASH_PREFIX)) return false;
  const expected = Buffer.from(storedHash.slice(HASH_PREFIX.length), 'hex');
  const actual = Buffer.from(hashBotToken(token).slice(HASH_PREFIX.length), 'hex');
  if (expected.length !== 32 || actual.length !== 32) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Extract the token from `Authorization: Bot <token>`. The scheme is
 * case-insensitive (RFC 9110); anything else — a Bearer token, a cookie,
 * a query parameter — is not a bot credential.
 */
export function readBotAuthorization(header: string | null | undefined): string | null {
  if (!header || header.length > MAX_AUTHORIZATION_LENGTH) return null;
  const match = /^Bot +([^\s]+)\s*$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/** A short, safe-to-show hint of a token (for confirmations and logs). */
export function redactBotToken(token: string): string {
  const parsed = BOT_TOKEN_PATTERN.exec(token);
  if (!parsed) return 'lfb_…';
  return `${BOT_TOKEN_PREFIX}${parsed[1]!.slice(0, 8)}…`;
}
