/**
 * Tests for guest-session validation at the WS upgrade boundary.
 *
 * The gateway closes the socket with code 4401 (a non-standard code
 * we picked for "unauthenticated") on auth failure. We only test the
 * validator itself here; the close code lives in `server.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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

// ── LF-SEC-009: tri-state revocation status ─────────────────────────────
// ioredis is mocked with a controllable fake so the OUTAGE paths are
// testable: 'unavailable' must be a distinct answer, never a silent
// "not revoked".

const sismember = vi.fn<(key: string, member: string) => Promise<number>>();

vi.mock('ioredis', () => ({
  default: class FakeRedis {
    on() {}
    sismember = sismember;
  },
}));

import { getRevocationStatus, isGuestSessionRevoked, __resetRevocationClient } from '../auth.js';

describe('getRevocationStatus (LF-SEC-009 tri-state)', () => {
  beforeEach(() => {
    __resetRevocationClient();
    sismember.mockReset();
  });

  it("'active' when Redis confirms the session is not revoked", async () => {
    sismember.mockResolvedValue(0);
    await expect(getRevocationStatus('u', 'g')).resolves.toBe('active');
  });

  it("'revoked' when the gid is in the revocation set", async () => {
    sismember.mockResolvedValue(1);
    await expect(getRevocationStatus('u', 'g')).resolves.toBe('revoked');
    await expect(isGuestSessionRevoked('u', 'g')).resolves.toBe(true);
  });

  it("'unavailable' when the Redis call errors — never a silent active", async () => {
    sismember.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(getRevocationStatus('u', 'g')).resolves.toBe('unavailable');
    // The boolean wrapper must NOT treat an outage as "not revoked".
    await expect(isGuestSessionRevoked('u', 'g')).resolves.toBe(false);
  });

  it("recovers after an error — one blip does not latch (no permanent failed flag)", async () => {
    sismember.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(1);
    await expect(getRevocationStatus('u', 'g')).resolves.toBe('unavailable');
    // The shared client is reused; the next call succeeds.
    await expect(getRevocationStatus('u', 'g')).resolves.toBe('revoked');
  });
});
