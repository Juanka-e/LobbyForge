/**
 * Signed-cookie helpers — shared between the web app and the ws-gateway.
 *
 * Each cookie value is `<base64url(payload)>.<base64url(hmac256(payload))>`
 * where the HMAC uses `LOBBYFORGE_SESSION_SECRET` (or whatever key the caller
 * passes). This is intentionally NOT a full JWT implementation — it doesn't
 * need cross-service portability for the guest-session use case, and keeping
 * the surface tiny makes it easy to audit.
 *
 * On the wire:
 *   - Tampering with the payload breaks the HMAC → `verify` returns `null`.
 *   - The payload is base64url-decoded as JSON. We never call `eval` or
 *     `new Function` on it.
 *   - Expiry is a property of the *payload* (`exp`, seconds since epoch), not
 *     of the cookie itself. The browser still gets a `Max-Age` hint for GC.
 */
import crypto from 'node:crypto';

const HMAC_ALGO = 'sha256';
const SEPARATOR = '.';

export interface SignOptions {
  /** Cookie name, used in the `Set-Cookie` header. */
  name: string;
  /** HMAC secret. Must be at least 32 bytes. */
  secret: string;
  /** `Max-Age` in seconds. Browser uses this for cookie GC. */
  maxAgeSeconds: number;
  /** Defaults to false (server-side cookie). */
  httpOnly?: boolean;
  /** Defaults to 'Lax'. Use 'Strict' for first-party-only endpoints. */
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** Cookie scope. Defaults to '/'. */
  path?: string;
  /** Mark the cookie Secure. Defaults to true in production. */
  secure?: boolean;
}

export interface SignResult {
  raw: string;
  setCookieHeader: string;
}

function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function hmac(secret: string, data: string): Buffer {
  return crypto.createHmac(HMAC_ALGO, secret).update(data).digest();
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readNodeEnv(): string {
  return (process.env as Record<string, string | undefined>).NODE_ENV ?? '';
}

export function signSessionCookie(
  payload: Record<string, unknown>,
  options: SignOptions
): SignResult {
  if (options.secret.length < 32) {
    throw new Error('signSessionCookie: secret must be at least 32 characters');
  }
  const json = JSON.stringify(payload);
  const body = base64urlEncode(json);
  const mac = base64urlEncode(hmac(options.secret, body));
  const raw = `${body}${SEPARATOR}${mac}`;

  const httpOnly = options.httpOnly !== false;
  const sameSite = options.sameSite ?? 'Lax';
  const path = options.path ?? '/';
  const secure = options.secure ?? readNodeEnv() === 'production';

  const parts = [
    `${options.name}=${raw}`,
    `Path=${path}`,
    `Max-Age=${options.maxAgeSeconds}`,
    httpOnly ? 'HttpOnly' : null,
    sameSite ? `SameSite=${sameSite}` : null,
    secure ? 'Secure' : null,
  ].filter((p): p is string => Boolean(p));
  const setCookieHeader = parts.join('; ');

  return { raw, setCookieHeader };
}

export function verifySessionCookie(
  raw: string,
  options: { secret: string; clockSkewSeconds?: number; now?: number }
): Record<string, unknown> | null {
  const sep = raw.indexOf(SEPARATOR);
  if (sep <= 0 || sep === raw.length - 1) return null;
  const body = raw.slice(0, sep);
  const mac = raw.slice(sep + 1);

  let expected: Buffer;
  let provided: Buffer;
  try {
    expected = hmac(options.secret, body);
    provided = base64urlDecode(mac);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, provided)) return null;

  let payload: Record<string, unknown>;
  try {
    const json = base64urlDecode(body).toString('utf8');
    payload = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof payload.exp === 'number') {
    const now = (options.now ?? Math.floor(Date.now() / 1000)) - (options.clockSkewSeconds ?? 0);
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  }
  return payload;
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

export function clearCookieHeader(name: string, path = '/'): string {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax`;
}
