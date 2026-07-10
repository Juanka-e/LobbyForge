/**
 * Tests for guest-session validation at the WS upgrade boundary.
 *
 * The gateway closes the socket with code 4401 (a non-standard code
 * we picked for "unauthenticated") on auth failure. We only test the
 * validator itself here; the close code lives in `server.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildGuestSessionCookie,
  type GuestIdentity,
} from '@lobbyforge/core';
import { validateGuestFromHeaders } from '../auth.js';

const SECRET = 'x'.repeat(32);

function makeCookie(uid: string | null = '00000000-0000-0000-0000-000000000001'): string {
  const identity: GuestIdentity = {
    gid: 'g_'.padEnd(34, 'a'),
    uid,
    name: 'Guest test',
  };
  return buildGuestSessionCookie(identity, SECRET).raw;
}

describe('validateGuestFromHeaders', () => {
  beforeEach(() => {
    process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  });

  it('accepts a signed cookie with a materialized uid', () => {
    const cookie = makeCookie();
    const result = validateGuestFromHeaders(`lf_guest=${cookie}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.guest.uid).toBe('00000000-0000-0000-0000-000000000001');
      expect(result.guest.gid).toMatch(/^g_/);
    }
  });

  it('rejects when no cookie header is present', () => {
    const result = validateGuestFromHeaders(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_cookie');
  });

  it('rejects when the cookie has no uid (pre-M10 cookie)', () => {
    const cookie = makeCookie(null);
    const result = validateGuestFromHeaders(`lf_guest=${cookie}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_uid');
  });

  it('rejects when the signature does not verify', () => {
    const tampered = makeCookie().slice(0, -3) + 'xxx';
    const result = validateGuestFromHeaders(`lf_guest=${tampered}`);
    expect(result.ok).toBe(false);
  });
});
