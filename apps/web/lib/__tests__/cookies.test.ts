import { describe, it, expect } from 'vitest';
import {
  signSessionCookie,
  verifySessionCookie,
  readCookie,
  clearCookieHeader,
} from '../cookies.js';

const SECRET = 'x'.repeat(32);
const NOW = 1_700_000_000;

describe('signSessionCookie', () => {
  it('produces a "body.mac" string and a Set-Cookie header', () => {
    const { raw, setCookieHeader } = signSessionCookie(
      { uid: 'u1', exp: NOW + 60 },
      { name: 'lf_test', secret: SECRET, maxAgeSeconds: 60 }
    );
    expect(raw).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(setCookieHeader).toContain('lf_test=');
    expect(setCookieHeader).toContain('Max-Age=60');
    expect(setCookieHeader).toContain('Path=/');
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('SameSite=Lax');
  });

  it('throws when the secret is too short', () => {
    expect(() =>
      signSessionCookie({ exp: NOW + 60 }, { name: 'x', secret: 'short', maxAgeSeconds: 60 })
    ).toThrow(/at least 32 characters/);
  });

  it('emits Secure when secure=true (or in production NODE_ENV)', () => {
    const envBag = process.env as Record<string, string | undefined>;
    const prev = envBag.NODE_ENV;
    try {
      envBag.NODE_ENV = 'production';
      const { setCookieHeader } = signSessionCookie(
        { exp: NOW + 60 },
        { name: 'x', secret: SECRET, maxAgeSeconds: 60 }
      );
      expect(setCookieHeader).toContain('Secure');
    } finally {
      envBag.NODE_ENV = prev;
    }
  });

  it('allows opting out of HttpOnly', () => {
    const { setCookieHeader } = signSessionCookie(
      { exp: NOW + 60 },
      { name: 'x', secret: SECRET, maxAgeSeconds: 60, httpOnly: false }
    );
    expect(setCookieHeader).not.toContain('HttpOnly');
  });
});

describe('verifySessionCookie', () => {
  it('round-trips a valid payload', () => {
    const { raw } = signSessionCookie(
      { uid: 'u1', iat: NOW, exp: NOW + 60 },
      { name: 'lf', secret: SECRET, maxAgeSeconds: 60 }
    );
    const payload = verifySessionCookie(raw, { secret: SECRET, now: NOW });
    expect(payload).toEqual({ uid: 'u1', iat: NOW, exp: NOW + 60 });
  });

  it('returns null on a tampered body', () => {
    const { raw } = signSessionCookie(
      { uid: 'u1', exp: NOW + 60 },
      { name: 'lf', secret: SECRET, maxAgeSeconds: 60 }
    );
    const [body, mac] = raw.split('.');
    // flip the last char of the body so the signature no longer matches
    const tamperedBody = body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A');
    const tampered = `${tamperedBody}.${mac}`;
    expect(verifySessionCookie(tampered, { secret: SECRET, now: NOW })).toBeNull();
  });

  it('returns null on a wrong secret', () => {
    const { raw } = signSessionCookie(
      { uid: 'u1', exp: NOW + 60 },
      { name: 'lf', secret: SECRET, maxAgeSeconds: 60 }
    );
    expect(verifySessionCookie(raw, { secret: 'y'.repeat(32), now: NOW })).toBeNull();
  });

  it('returns null when expired', () => {
    const { raw } = signSessionCookie(
      { uid: 'u1', exp: NOW + 30 },
      { name: 'lf', secret: SECRET, maxAgeSeconds: 60 }
    );
    expect(verifySessionCookie(raw, { secret: SECRET, now: NOW + 60 })).toBeNull();
  });

  it('respects clockSkewSeconds for borderline cases', () => {
    const { raw } = signSessionCookie(
      { uid: 'u1', exp: NOW },
      { name: 'lf', secret: SECRET, maxAgeSeconds: 60 }
    );
    // Without skew, NOW == exp is still valid (the spec says < not <=).
    expect(verifySessionCookie(raw, { secret: SECRET, now: NOW })).not.toBeNull();
    // With 5 s of clock skew, NOW is 5 s past exp → reject.
    expect(verifySessionCookie(raw, { secret: SECRET, now: NOW + 5, clockSkewSeconds: 0 })).toBeNull();
    // …but with 10 s of clock skew applied to the verifier, NOW is still inside the window.
    expect(verifySessionCookie(raw, { secret: SECRET, now: NOW + 5, clockSkewSeconds: 10 })).not.toBeNull();
  });

  it('accepts payloads with no `exp` claim', () => {
    const { raw } = signSessionCookie(
      { uid: 'u1' },
      { name: 'lf', secret: SECRET, maxAgeSeconds: 60 }
    );
    expect(verifySessionCookie(raw, { secret: SECRET, now: NOW })).toEqual({ uid: 'u1' });
  });

  it('returns null on malformed input', () => {
    expect(verifySessionCookie('no-separator', { secret: SECRET, now: NOW })).toBeNull();
    expect(verifySessionCookie('.only-mac', { secret: SECRET, now: NOW })).toBeNull();
    expect(verifySessionCookie('only-body.', { secret: SECRET, now: NOW })).toBeNull();
  });
});

describe('readCookie', () => {
  it('returns the value of a named cookie', () => {
    expect(readCookie('a=1; b=2; c=3', 'b')).toBe('2');
  });
  it('handles missing header', () => {
    expect(readCookie(null, 'a')).toBeNull();
  });
  it('returns null when the cookie is absent', () => {
    expect(readCookie('a=1; b=2', 'z')).toBeNull();
  });
  it('trims surrounding whitespace', () => {
    expect(readCookie('  a=1 ;   b=2  ', 'a')).toBe('1');
  });
});

describe('clearCookieHeader', () => {
  it('emits a Max-Age=0 Set-Cookie', () => {
    expect(clearCookieHeader('lf_session')).toContain('Max-Age=0');
    expect(clearCookieHeader('lf_session')).toContain('lf_session=');
  });
});
