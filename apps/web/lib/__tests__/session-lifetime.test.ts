import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie as buildCoreCookie } from '@lobbyforge/core';

/**
 * Security follow-up (absolute session lifetime): the web app's cookie
 * helpers apply LOBBYFORGE_SESSION_MAX_AGE_DAYS, and an over-age session
 * is signed out for pages (getActiveSession) like everywhere else.
 */

const { isSessionRevoked } = vi.hoisted(() => ({ isSessionRevoked: vi.fn() }));
vi.mock('@/lib/session-tracker', () => ({ isSessionRevoked }));

import { sessionMaxAgeSeconds } from '../session-lifetime.js';
import { buildGuestSessionCookie, readGuestSession } from '../guest-session.js';
import { getActiveSession } from '../active-session.js';

const SECRET = 's'.repeat(48);
const DAY = 24 * 60 * 60;
const USER_ID = '00000000-0000-4000-8000-000000000001';
const IDENTITY = { gid: `g_${'1'.repeat(32)}`, uid: USER_ID, name: 'Owner' };

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A cookie whose session started `ageDays` ago but whose exp is still live. */
function agedCookie(ageDays: number, uid: string | null = USER_ID): string {
  const signed = buildCoreCookie({ ...IDENTITY, uid }, SECRET, {
    authTime: nowSeconds() - ageDays * DAY,
    maxAgeSeconds: 365 * DAY,
  });
  return `lf_guest=${signed.raw}`;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  isSessionRevoked.mockReset().mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sessionMaxAgeSeconds', () => {
  it('defaults to 30 days', () => {
    expect(sessionMaxAgeSeconds(undefined)).toBe(30 * DAY);
    expect(sessionMaxAgeSeconds('  ')).toBe(30 * DAY);
  });

  it('reads whole and fractional days', () => {
    expect(sessionMaxAgeSeconds('7')).toBe(7 * DAY);
    expect(sessionMaxAgeSeconds('0.5')).toBe(DAY / 2);
  });

  it('clamps to 1 hour … 365 days', () => {
    expect(sessionMaxAgeSeconds('0.001')).toBe(3600);
    expect(sessionMaxAgeSeconds('100000')).toBe(365 * DAY);
  });

  it('falls back to the default for nonsense, warning once per value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(sessionMaxAgeSeconds('forever')).toBe(30 * DAY);
      expect(sessionMaxAgeSeconds('forever')).toBe(30 * DAY);
      expect(sessionMaxAgeSeconds('0')).toBe(30 * DAY);
      expect(sessionMaxAgeSeconds('-3')).toBe(30 * DAY);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('reads LOBBYFORGE_SESSION_MAX_AGE_DAYS by default', () => {
    vi.stubEnv('LOBBYFORGE_SESSION_MAX_AGE_DAYS', '2');
    expect(sessionMaxAgeSeconds()).toBe(2 * DAY);
  });
});

describe('web cookie helpers apply the configured lifetime', () => {
  it('new cookies cap exp at auth_time + the configured lifetime', () => {
    vi.stubEnv('LOBBYFORGE_SESSION_MAX_AGE_DAYS', '1');
    const now = nowSeconds();
    const signed = buildGuestSessionCookie(IDENTITY, SECRET, { now, authTime: now - DAY + 120 });
    expect(signed.payload.exp).toBe(now + 120);
  });

  it('readGuestSession signs out a session older than the configured lifetime', () => {
    expect(readGuestSession(agedCookie(29), SECRET)).not.toBeNull();
    expect(readGuestSession(agedCookie(31), SECRET)).toBeNull();
    vi.stubEnv('LOBBYFORGE_SESSION_MAX_AGE_DAYS', '90');
    expect(readGuestSession(agedCookie(31), SECRET)).not.toBeNull();
  });

  it('applies to guest sessions (no uid) too — their identity is the cookie', () => {
    expect(readGuestSession(agedCookie(31, null), SECRET)).toBeNull();
  });
});

describe('getActiveSession — absolute lifetime', () => {
  it('treats an over-age session as signed out without touching Redis', async () => {
    await expect(getActiveSession(agedCookie(31), SECRET)).resolves.toBeNull();
    expect(isSessionRevoked).not.toHaveBeenCalled();
  });

  it('still returns a session inside its lifetime', async () => {
    await expect(getActiveSession(agedCookie(1), SECRET)).resolves.toMatchObject({ uid: USER_ID });
  });
});
