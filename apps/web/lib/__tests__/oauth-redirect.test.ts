import { describe, expect, it } from 'vitest';
import { sanitizeOAuthRedirect } from '../oauth-redirect.js';

/** SEC-005: protocol-relative / backslash / CRLF redirect payloads. */
describe('sanitizeOAuthRedirect', () => {
  it('accepts plain same-origin paths', () => {
    expect(sanitizeOAuthRedirect('/lobby')).toBe('/lobby');
    expect(sanitizeOAuthRedirect('/settings/profile?tab=1')).toBe('/settings/profile?tab=1');
    expect(sanitizeOAuthRedirect(null)).toBe('/lobby');
    expect(sanitizeOAuthRedirect('')).toBe('/lobby');
  });

  it('rejects protocol-relative URLs (raw and encoded)', () => {
    expect(sanitizeOAuthRedirect('//evil.example')).toBe('/lobby');
    expect(sanitizeOAuthRedirect('%2F%2Fevil.example')).toBe('/lobby');
    expect(sanitizeOAuthRedirect('/\\evil.example')).toBe('/lobby');
    expect(sanitizeOAuthRedirect('\\\\evil.example')).toBe('/lobby');
  });

  it('rejects absolute and scheme URLs', () => {
    expect(sanitizeOAuthRedirect('https://evil.example')).toBe('/lobby');
    expect(sanitizeOAuthRedirect('http://evil.example')).toBe('/lobby');
    expect(sanitizeOAuthRedirect('https%3A%2F%2Fevil.example')).toBe('/lobby');
  });

  it('rejects CRLF / control characters (header injection)', () => {
    expect(sanitizeOAuthRedirect('/lobby\r\nSet-Cookie: x=1')).toBe('/lobby');
    expect(sanitizeOAuthRedirect('/lob\u0000by')).toBe('/lobby');
  });
});
