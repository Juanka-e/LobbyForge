/**
 * VOICE-001: ephemeral TURN credentials (coturn REST auth).
 *
 * Pins the credential derivation to the coturn REST API scheme —
 * username = `${unixExpiry}:${suffix}`, credential = base64(
 * HMAC-SHA1(staticSecret, username)) — and the ice-server shape the
 * token endpoint hands to clients.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveEphemeralTurnCredential,
  getEphemeralTurnIceServers,
  TURN_CREDENTIAL_TTL_SECONDS,
} from '../turn-credentials';

const SECRET = 'ab'.repeat(32); // 64 hex chars — the render script's format
const OTHER_SECRET = 'cd'.repeat(32);

describe('deriveEphemeralTurnCredential', () => {
  it('derives the coturn REST-auth scheme: expiry:suffix + HMAC-SHA1', () => {
    const now = 1_700_000_000_000;
    const { username, credential, expiresAtEpoch } = deriveEphemeralTurnCredential(
      SECRET,
      'user-123',
      { nowMs: now, ttlSeconds: 3600 }
    );
    expect(expiresAtEpoch).toBe(1_700_000_000 + 3600);
    expect(username).toBe(`${1_700_000_000 + 3600}:user-123`);
    // Independent re-derivation with node:crypto must match byte-for-byte.
    const expected = createHmac('sha1', SECRET).update(username).digest('base64');
    expect(credential).toBe(expected);
  });

  it('default TTL matches the LiveKit token TTL (one session, one credential)', () => {
    const { username } = deriveEphemeralTurnCredential(SECRET, 'u', {
      nowMs: 1_000_000,
    });
    expect(username.startsWith(`${Math.floor(1_000_000 / 1000) + TURN_CREDENTIAL_TTL_SECONDS}:`)).toBe(true);
  });

  it('changes completely with a different secret or suffix (no collisions)', () => {
    const a = deriveEphemeralTurnCredential(SECRET, 'user-1', { nowMs: 5 });
    const b = deriveEphemeralTurnCredential(OTHER_SECRET, 'user-1', { nowMs: 5 });
    const c = deriveEphemeralTurnCredential(SECRET, 'user-2', { nowMs: 5 });
    expect(a.credential).not.toBe(b.credential);
    expect(a.username).not.toBe(c.username);
    expect(a.credential).not.toBe(c.credential);
  });

  it('sanitizes the suffix — config syntax can never ride in the username', () => {
    const evil = 'u:ser\nstatic-auth-secret=x';
    const { username } = deriveEphemeralTurnCredential(SECRET, evil, { nowMs: 0 });
    expect(username).toMatch(/^\d+:userstatic-auth-secretx$/);
  });
});

describe('getEphemeralTurnIceServers', () => {
  beforeEach(() => {
    process.env.LOBBYFORGE_TURN_SECRET = SECRET;
    delete process.env.LOBBYFORGE_TURN_HOST;
    process.env.NEXT_PUBLIC_BASE_URL = 'https://voice.example.com';
  });
  afterEach(() => {
    delete process.env.LOBBYFORGE_TURN_SECRET;
    delete process.env.LOBBYFORGE_TURN_HOST;
  });

  it('returns udp+tcp+tls ICE servers on the stack domain', () => {
    const ice = getEphemeralTurnIceServers('user-42');
    expect(ice).not.toBeNull();
    expect(ice!.urls).toEqual([
      'turn:voice.example.com:3478?transport=udp',
      'turn:voice.example.com:3478?transport=tcp',
      'turns:voice.example.com:5349?transport=tcp',
    ]);
    expect(ice!.username).toContain('user-42');
    expect(ice!.credential).toBe(
      createHmac('sha1', SECRET).update(ice!.username).digest('base64')
    );
  });

  it('honors an explicit LOBBYFORGE_TURN_HOST over the base URL', () => {
    process.env.LOBBYFORGE_TURN_HOST = 'relay.example.net';
    const ice = getEphemeralTurnIceServers('u');
    expect(ice!.urls[0]).toBe('turn:relay.example.net:3478?transport=udp');
  });

  it('returns null when TURN is not deployed (dev stacks without coturn)', () => {
    delete process.env.LOBBYFORGE_TURN_SECRET;
    expect(getEphemeralTurnIceServers('u')).toBeNull();
  });

  it('returns null for a malformed secret instead of minting weak credentials', () => {
    process.env.LOBBYFORGE_TURN_SECRET = 'short';
    expect(getEphemeralTurnIceServers('u')).toBeNull();
    process.env.LOBBYFORGE_TURN_SECRET = 'zz'.repeat(32); // non-hex
    expect(getEphemeralTurnIceServers('u')).toBeNull();
  });
});
