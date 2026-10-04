/**
 * Signed service-to-service requests between LobbyForge's own processes on
 * the compose-internal network (ADR-007: the ws-gateway asks the web app to
 * project a marketplace plugin's state, because only web can reach the
 * plugin worker).
 *
 * No new secret: the key is derived from LOBBYFORGE_SESSION_SECRET, which
 * both web and the gateway already hold (the gateway verifies guest
 * cookies with it — a process holding it can already act as any user).
 * The purpose string separates keys per endpoint. Each request signs a
 * timestamp and its exact body, and is accepted for a short window only.
 *
 * Header: `x-lf-internal-signature: t=<unix seconds>,v1=<hex hmac>`,
 * hmac = HMAC-SHA256(key, `${t}.${body}`).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const INTERNAL_SIGNATURE_HEADER = 'x-lf-internal-signature';
export const INTERNAL_SIGNATURE_MAX_SKEW_SECONDS = 60;
/** ws-gateway → web `POST /api/internal/activity-projection`. */
export const ACTIVITY_PROJECTION_PURPOSE = 'activity-projection';

function deriveKey(sessionSecret: string, purpose: string): Buffer {
  return createHmac('sha256', sessionSecret).update(`lobbyforge:internal:${purpose}:v1`).digest();
}

/** The header value for `body`, signed now. */
export function signInternalRequest(sessionSecret: string, purpose: string, body: string, nowMs = Date.now()): string {
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('LOBBYFORGE_SESSION_SECRET must be at least 32 characters');
  const t = Math.floor(nowMs / 1000);
  const mac = createHmac('sha256', deriveKey(sessionSecret, purpose)).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${mac}`;
}

/** True when `header` signs exactly `body` for `purpose`, within the skew window. */
export function verifyInternalRequest(
  sessionSecret: string | undefined,
  purpose: string,
  header: string | null | undefined,
  body: string,
  nowMs = Date.now()
): boolean {
  if (!sessionSecret || sessionSecret.length < 32 || !header) return false;
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header.trim());
  if (!match) return false;
  const t = Number(match[1]);
  if (!Number.isSafeInteger(t) || Math.abs(Math.floor(nowMs / 1000) - t) > INTERNAL_SIGNATURE_MAX_SKEW_SECONDS) return false;
  const expected = createHmac('sha256', deriveKey(sessionSecret, purpose)).update(`${t}.${body}`).digest('hex');
  // Hash both sides first: constant-time and length-independent.
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(match[2]!).digest();
  return timingSafeEqual(a, b);
}
