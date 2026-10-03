import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertLevel, DoctorCategory } from '@lobbyforge/core';
import { buildTrustedProxyCheck } from '../doctor.js';

/**
 * Security follow-up (review §7.5): production without
 * LOBBYFORGE_TRUSTED_PROXY puts every client in one rate-limit bucket.
 * Existing installs keep running; Doctor reports a warning with the fix,
 * and the console warning is logged once per process, not per request.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buildTrustedProxyCheck', () => {
  it.each([
    ['unset', undefined, 'is not set'],
    ['empty', '  ', 'is not set'],
    ['"none"', 'none', 'is "none"'],
    ['unrecognised', 'nginx', '"nginx" is not recognised'],
  ])('warns in production when the trusted proxy is %s, with the fix', (_label, trustedProxy, problem) => {
    const check = buildTrustedProxyCheck({ nodeEnv: 'production', trustedProxy });
    expect(check).toMatchObject({
      id: 'trusted_proxy',
      category: DoctorCategory.NETWORK,
      ok: false,
      level: AlertLevel.WARNING,
    });
    expect(check.message).toContain(problem);
    expect(check.message).toContain('one rate-limit bucket');
    expect(check.message).toContain('LOBBYFORGE_TRUSTED_PROXY=x-forwarded-for');
  });

  it('is never critical — a missing proxy setting must not fail the report', () => {
    expect(buildTrustedProxyCheck({ nodeEnv: 'production' }).level).not.toBe(AlertLevel.CRITICAL);
  });

  it('passes for x-forwarded-for', () => {
    expect(buildTrustedProxyCheck({ nodeEnv: 'production', trustedProxy: 'x-forwarded-for' })).toMatchObject({
      ok: true,
      level: AlertLevel.INFO,
      detail: { mode: 'x-forwarded-for' },
    });
  });

  it('passes for cloudflare but says when that is safe', () => {
    const check = buildTrustedProxyCheck({ nodeEnv: 'production', trustedProxy: 'cloudflare' });
    expect(check.ok).toBe(true);
    expect(check.message).toContain('Cloudflare alone');
    expect(check.message).toContain('cf-real-ip.conf');
  });

  it('is informational outside production', () => {
    expect(buildTrustedProxyCheck({ nodeEnv: 'development' })).toMatchObject({ ok: true, level: AlertLevel.INFO });
  });
});

describe('collectDoctorReport includes the trusted_proxy check', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ getDb: () => ({ execute: vi.fn(async () => [{ ok: 1 }]) }) }));
    vi.doMock('@/lib/redis', () => ({ redis: { ping: vi.fn().mockResolvedValue('PONG') } }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', '');
  });

  it('as a warning that does not flip the report to failing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOBBYFORGE_TRUSTED_PROXY', '');
    const { collectDoctorReport } = await import('../doctor.js');
    const { report } = await collectDoctorReport();
    const check = report.checks.find((c) => c.id === 'trusted_proxy');
    expect(check).toMatchObject({ ok: false, level: AlertLevel.WARNING });
    expect(report.summary.warning).toBeGreaterThanOrEqual(1);
    expect(report.ok).toBe(true);
  }, 15000);

  it('as passing when configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOBBYFORGE_TRUSTED_PROXY', 'x-forwarded-for');
    const { collectDoctorReport } = await import('../doctor.js');
    const { report } = await collectDoctorReport();
    expect(report.checks.find((c) => c.id === 'trusted_proxy')?.ok).toBe(true);
  }, 15000);
});

describe('resolveClientAddress — untrusted-proxy warning', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is logged once per process in production, not on every request', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOBBYFORGE_TRUSTED_PROXY', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { resolveClientAddress } = await import('../security-headers.js');
    for (let i = 0; i < 5; i += 1) {
      expect(resolveClientAddress(new Request('https://example.test/'))).toBe('unknown');
    }
    const proxyWarnings = warn.mock.calls.filter(([message]) => String(message).includes('LOBBYFORGE_TRUSTED_PROXY'));
    expect(proxyWarnings).toHaveLength(1);
  });

  it('is not logged outside production or with a trusted proxy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { resolveClientAddress } = await import('../security-headers.js');
    vi.stubEnv('NODE_ENV', 'development');
    resolveClientAddress(new Request('https://example.test/'), 'none');
    vi.stubEnv('NODE_ENV', 'production');
    resolveClientAddress(new Request('https://example.test/', { headers: { 'x-forwarded-for': '10.0.0.2' } }), 'x-forwarded-for');
    expect(warn).not.toHaveBeenCalled();
  });
});
