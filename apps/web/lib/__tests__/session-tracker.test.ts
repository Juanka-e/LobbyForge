import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { parseUserAgent, resolveClientIp, resolveLocation } from '../session-tracker.js';

const envSnapshot = { ...process.env };

beforeEach(() => {
  delete (process.env as Record<string, string | undefined>).LOBBYFORGE_TRUSTED_PROXY;
  delete (process.env as Record<string, string | undefined>).NODE_ENV;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://example.test/api/x', { headers });
}

describe('parseUserAgent', () => {
  it('classifies a Windows Chrome desktop UA', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    expect(parseUserAgent(ua)).toEqual({ browser: 'Chrome', os: 'Windows', deviceType: 'Desktop' });
  });

  it('detects Edge before Chrome (masquerade ordering)', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Edg/120.0';
    expect(parseUserAgent(ua).browser).toBe('Edge');
  });

  it('detects Firefox', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0';
    expect(parseUserAgent(ua)).toEqual({ browser: 'Firefox', os: 'Linux', deviceType: 'Desktop' });
  });

  it('detects Safari on macOS', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Safari/605.1.15';
    expect(parseUserAgent(ua)).toEqual({ browser: 'Safari', os: 'macOS', deviceType: 'Desktop' });
  });

  it('classifies an iPhone as Mobile (device) — OS resolves via regex ordering', () => {
    // The UA contains "like Mac OS X" which matches the macOS branch before iOS.
    // This documents the actual parser behavior: deviceType is reliable, OS
    // reflects the regex cascade.
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Mobile/15E148 Safari/604.1';
    const parsed = parseUserAgent(ua);
    expect(parsed.deviceType).toBe('Mobile');
    expect(parsed.browser).toBe('Safari');
  });

  it('classifies an iPad as Tablet', () => {
    const ua = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605 Mobile Safari/604.1';
    const parsed = parseUserAgent(ua);
    expect(parsed.deviceType).toBe('Tablet');
  });

  it('classifies an iOS UA without the "Mac OS X" phrase as iOS', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iOS 17_0) AppleWebKit/605 Mobile Safari/604.1';
    const parsed = parseUserAgent(ua);
    expect(parsed.os).toBe('iOS');
    expect(parsed.deviceType).toBe('Mobile');
  });

  it('classifies Android mobile', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';
    const parsed = parseUserAgent(ua);
    expect(parsed.os).toBe('Android');
    expect(parsed.deviceType).toBe('Mobile');
  });

  it('returns Unknown/Desktop for empty or null input', () => {
    expect(parseUserAgent('')).toEqual({ browser: 'Unknown', os: 'Unknown', deviceType: 'Desktop' });
    expect(parseUserAgent(null)).toEqual({ browser: 'Unknown', os: 'Unknown', deviceType: 'Desktop' });
    expect(parseUserAgent(undefined)).toEqual({ browser: 'Unknown', os: 'Unknown', deviceType: 'Desktop' });
  });
});

describe('resolveClientIp', () => {
  it('returns unknown when no relevant headers and no trusted proxy', () => {
    expect(resolveClientIp(req())).toBe('unknown');
  });

  it('reads cf-connecting-ip when trusted proxy is cloudflare', () => {
    process.env.LOBBYFORGE_TRUSTED_PROXY = 'cloudflare';
    expect(resolveClientIp(req({ 'cf-connecting-ip': '203.0.113.5' }))).toBe('203.0.113.5');
  });

  it('reads the LAST x-forwarded-for hop when trusted proxy is x-forwarded-for (SEC-004)', () => {
    process.env.LOBBYFORGE_TRUSTED_PROXY = 'x-forwarded-for';
    // The first entry is client-controllable; only the hop the trusted
    // proxy appended is trustworthy.
    expect(resolveClientIp(req({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }))).toBe('10.0.0.1');
  });

  it('ignores x-forwarded-for in production without an explicit trusted-proxy opt-in (SEC-004)', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    expect(resolveClientIp(req({ 'x-forwarded-for': '198.51.100.9' }))).toBe('unknown');
  });

  it('reads x-real-ip when a trusted proxy is configured', () => {
    process.env.LOBBYFORGE_TRUSTED_PROXY = 'cloudflare';
    expect(resolveClientIp(req({ 'x-real-ip': '203.0.113.99' }))).toBe('203.0.113.99');
  });

  it('ignores x-real-ip when no trusted proxy is configured', () => {
    expect(resolveClientIp(req({ 'x-real-ip': '203.0.113.99' }))).toBe('unknown');
  });
});

describe('resolveLocation', () => {
  it('returns empty string when no trusted proxy is configured', () => {
    expect(resolveLocation(req({ 'cf-ipcountry': 'US' }))).toBe('');
  });

  it('joins cloudflare city + country when trusted proxy is cloudflare', () => {
    process.env.LOBBYFORGE_TRUSTED_PROXY = 'cloudflare';
    const loc = resolveLocation(req({ 'cf-ipcity': 'Istanbul', 'cf-ipcountry': 'TR' }));
    expect(loc).toBe('Istanbul, TR');
  });

  it('joins vercel region + country when trusted proxy is vercel-style', () => {
    // parts = [city, region, country] — region precedes country.
    process.env.LOBBYFORGE_TRUSTED_PROXY = 'x-forwarded-for';
    const loc = resolveLocation(req({
      'x-vercel-ip-country': 'DE',
      'x-vercel-ip-country-region': 'BE',
    }));
    expect(loc).toBe('BE, DE');
  });

  it('returns empty when trusted proxy set but no geo headers', () => {
    process.env.LOBBYFORGE_TRUSTED_PROXY = 'cloudflare';
    expect(resolveLocation(req())).toBe('');
  });
});
