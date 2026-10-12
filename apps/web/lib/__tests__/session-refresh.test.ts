/**
 * The sliding session (lib/session-refresh.ts, docs/GUEST_AUTH.md
 * "Lifetime"). Before 2026-10-13 a cookie lived one hour and nothing
 * re-signed one that was still valid, so signed-in users were signed out
 * after an hour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GUEST_SESSION_TTL_SECONDS, guestSessionNeedsRefresh } from '@lobbyforge/core';
import { buildGuestSessionCookie, readGuestSession } from '@/lib/guest-session';
import { refreshedSessionCookie, setsSessionCookie, withRefreshedSession } from '@/lib/session-refresh';

const SECRET = 's'.repeat(40);
const IDENTITY = { gid: 'g_' + 'a'.repeat(32), uid: '11111111-1111-4111-8111-111111111111', name: 'Ayşe' };
const NOW = 1_800_000_000;
const DAY = 24 * 60 * 60;

/** A cookie header for a session issued at `issuedAt` (first signed in at `authTime`). */
function cookieAt(issuedAt: number, authTime = issuedAt): string {
  const signed = buildGuestSessionCookie(IDENTITY, SECRET, { now: issuedAt, authTime });
  return `${signed.setCookieHeader.split(';')[0]}`;
}

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  vi.stubEnv('LOBBYFORGE_SESSION_MAX_AGE_DAYS', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('guestSessionNeedsRefresh', () => {
  it('is due once less than half of the TTL is left, never before', () => {
    const exp = NOW + GUEST_SESSION_TTL_SECONDS;
    expect(guestSessionNeedsRefresh({ exp, auth_time: NOW }, { now: NOW })).toBe(false);
    expect(guestSessionNeedsRefresh({ exp, auth_time: NOW }, { now: exp - GUEST_SESSION_TTL_SECONDS / 2 + 1 })).toBe(true);
  });

  it('is never due when re-signing could not move the expiry (the absolute lifetime is reached)', () => {
    const authTime = NOW - 30 * DAY + 60;
    const exp = authTime + 30 * DAY; // already capped
    expect(guestSessionNeedsRefresh({ exp, auth_time: authTime }, { now: NOW, maxAgeSeconds: 30 * DAY })).toBe(false);
  });
});

describe('refreshedSessionCookie', () => {
  it('leaves a fresh session alone', () => {
    expect(refreshedSessionCookie(cookieAt(NOW), NOW + 60)).toBeNull();
  });

  it('re-signs a session past half its lifetime: same session id and auth_time, a new expiry', () => {
    const later = NOW + 4 * DAY;
    const header = refreshedSessionCookie(cookieAt(NOW), later);
    expect(header).toMatch(/^lf_guest=/);
    expect(header).toContain(`Max-Age=${GUEST_SESSION_TTL_SECONDS}`);
    const session = readGuestSession(header!.split(';')[0]!, SECRET, { now: later });
    expect(session).toMatchObject({ gid: IDENTITY.gid, uid: IDENTITY.uid, name: IDENTITY.name, iat: later, auth_time: NOW });
    expect(session!.exp).toBe(later + GUEST_SESSION_TTL_SECONDS);
  });

  it('never carries a session past its absolute lifetime', () => {
    const authTime = NOW - 25 * DAY;
    const later = NOW;
    const header = refreshedSessionCookie(cookieAt(NOW - 4 * DAY, authTime), later);
    const session = readGuestSession(header!.split(';')[0]!, SECRET, { now: later });
    expect(session!.exp).toBe(authTime + 30 * DAY);
  });

  it('does not refresh an expired, forged, missing or over-age cookie', () => {
    expect(refreshedSessionCookie(cookieAt(NOW), NOW + GUEST_SESSION_TTL_SECONDS + 5)).toBeNull();
    expect(refreshedSessionCookie(cookieAt(NOW).slice(0, -2) + 'xx', NOW + 4 * DAY)).toBeNull();
    expect(refreshedSessionCookie(null)).toBeNull();
    expect(refreshedSessionCookie('other=1')).toBeNull();
    expect(refreshedSessionCookie(cookieAt(NOW - 3 * DAY, NOW - 31 * DAY), NOW)).toBeNull();
  });

  it('does nothing without a usable secret', () => {
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'short');
    expect(refreshedSessionCookie(cookieAt(NOW), NOW + 4 * DAY)).toBeNull();
  });
});

describe('withRefreshedSession', () => {
  const due = () => new Request('https://chat.example.test/api/x', { headers: { cookie: cookieAt(Math.floor(Date.now() / 1000) - 4 * DAY) } });

  it('adds the re-signed cookie to a successful answer', () => {
    const response = withRefreshedSession(due(), NextResponse.json({ ok: true }));
    expect(setsSessionCookie(response.headers)).toBe(true);
  });

  it('adds nothing to a refused answer, or to one that sets or clears the cookie itself', () => {
    expect(setsSessionCookie(withRefreshedSession(due(), NextResponse.json({}, { status: 401 })).headers)).toBe(false);
    const signOut = NextResponse.json({ ok: true });
    signOut.headers.append('Set-Cookie', 'lf_guest=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    const after = withRefreshedSession(due(), signOut);
    expect(after.headers.getSetCookie()).toEqual(['lf_guest=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax']);
  });
});
