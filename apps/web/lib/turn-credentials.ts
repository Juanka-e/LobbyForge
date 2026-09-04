/**
 * Ephemeral TURN credentials (VOICE-001).
 *
 * coturn runs with `use-auth-secret` (REST API auth): instead of a static
 * user table, it accepts TIME-LIMITED credentials derived from the shared
 * static-auth-secret:
 *
 *   username   = `${unixExpiry}:${suffix}`
 *   credential = base64(HMAC-SHA1(secret, username))
 *
 * The old deployment handed ONE permanent credential to every community
 * member via LiveKit's rtc.turn_servers — anyone who ever joined a voice
 * channel could relay through the server forever. Now the web app mints a
 * per-user credential alongside each LiveKit token (1h, matching the token
 * TTL) and clients pass it in rtcConfig. coturn expires the username, so
 * the credential dies on its own; `user-quota` in turnserver.conf now
 * counts allocations per USER again (the suffix is the user id).
 */
import { createHmac } from 'node:crypto';

/** Matches the LiveKit token TTL — one voice session, one credential. */
export const TURN_CREDENTIAL_TTL_SECONDS = 60 * 60;

const SECRET_PATTERN = /^[0-9a-fA-F]{32,128}$/;

/** Derive the time-limited username/password pair (coturn REST auth). */
export function deriveEphemeralTurnCredential(
  secret: string,
  suffix: string,
  options: { ttlSeconds?: number; nowMs?: number } = {}
): { username: string; credential: string; expiresAtEpoch: number } {
  const ttl = options.ttlSeconds ?? TURN_CREDENTIAL_TTL_SECONDS;
  const now = options.nowMs ?? Date.now();
  const expiry = Math.floor(now / 1000) + ttl;
  // The suffix becomes part of the HMAC'd username — keep it to a safe
  // charset so it can never smuggle TURN-side semantics.
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const username = `${expiry}:${safeSuffix}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAtEpoch: expiry };
}

/**
 * Build the RTCIceServer entry handed to the LiveKit client, or null when
 * TURN is not configured (dev stacks without coturn — clients then rely on
 * direct/STUN paths only, exactly as before TURN existed).
 */
export function getEphemeralTurnIceServers(
  userSuffix: string
): { urls: string[]; username: string; credential: string } | null {
  const secret = process.env.LOBBYFORGE_TURN_SECRET;
  if (!secret || !SECRET_PATTERN.test(secret)) return null;

  const host =
    process.env.LOBBYFORGE_TURN_HOST || hostnameFromBaseUrl(process.env.NEXT_PUBLIC_BASE_URL);
  if (!host) return null;

  const { username, credential } = deriveEphemeralTurnCredential(secret, userSuffix);
  return {
    // udp + tcp on 3478, TLS on 5349 — the same trio LiveKit used to
    // advertise; tried only after direct/STUN paths fail (ICE fallback).
    urls: [
      `turn:${host}:3478?transport=udp`,
      `turn:${host}:3478?transport=tcp`,
      `turns:${host}:5349?transport=tcp`,
    ],
    username,
    credential,
  };
}

function hostnameFromBaseUrl(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return null;
  }
}
