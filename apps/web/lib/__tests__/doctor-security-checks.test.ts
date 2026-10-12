/**
 * Doctor checks added by the 2026-10 uploads/infra review:
 *   - image_storage  (security-review FILE-001): images kept in Postgres;
 *   - client_address (security-review INFRA-V-01): proxied client
 *     addresses that are really one Docker bridge gateway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertLevel, DoctorCategory } from '@lobbyforge/core';
import {
  buildClientAddressCheck,
  buildImageStorageCheck,
  IMAGE_STORAGE_WARN_BYTES,
  imageStorageWarnBytes,
  isGatewayLikeAddress,
  parseDefaultGateways,
} from '../doctor.js';

const MB = 1024 * 1024;
const totals = (over: Partial<Parameters<typeof buildImageStorageCheck>[0]> = {}) => ({
  totalBytes: 300 * MB,
  userBytes: 250 * MB,
  guestBytes: 0,
  serverBytes: 48 * MB,
  logoBytes: 2 * MB,
  ...over,
});

describe('image_storage (security-review FILE-001)', () => {
  it('is informational below the threshold, with the breakdown', () => {
    const check = buildImageStorageCheck(totals(), IMAGE_STORAGE_WARN_BYTES);
    expect(check).toMatchObject({ id: 'image_storage', category: DoctorCategory.SYSTEM, ok: true, level: AlertLevel.INFO });
    expect(check.message).toContain('300 MB');
    expect(check.message).toContain('server banners 48 MB');
  });

  it('warns at or above the threshold — without failing the report', () => {
    const check = buildImageStorageCheck(
      totals({ totalBytes: 1536 * MB, userBytes: 1500 * MB, guestBytes: 700 * MB, serverBytes: 34 * MB }),
      IMAGE_STORAGE_WARN_BYTES
    );
    expect(check).toMatchObject({ ok: false, level: AlertLevel.WARNING });
    expect(check.message).toMatch(/1536 MB of the database, above the 1024 MB warning threshold/);
    expect(check.message).toContain('guests 700 MB');
    expect(check.message).toMatch(/Guests can no longer upload images/);
    expect(check.message).toContain('LOBBYFORGE_IMAGE_STORAGE_WARN_MB');
    expect(check.detail).toMatchObject({ guestBytes: 700 * MB, warnBytes: IMAGE_STORAGE_WARN_BYTES });
  });

  it('reads the threshold from LOBBYFORGE_IMAGE_STORAGE_WARN_MB, ignoring nonsense', () => {
    expect(imageStorageWarnBytes({})).toBe(1024 * MB);
    expect(imageStorageWarnBytes({ LOBBYFORGE_IMAGE_STORAGE_WARN_MB: '250' })).toBe(250 * MB);
    expect(imageStorageWarnBytes({ LOBBYFORGE_IMAGE_STORAGE_WARN_MB: '-5' })).toBe(1024 * MB);
    expect(imageStorageWarnBytes({ LOBBYFORGE_IMAGE_STORAGE_WARN_MB: 'lots' })).toBe(1024 * MB);
  });
});

describe('client_address (security-review INFRA-V-01)', () => {
  const visitors = Array.from({ length: 30 }, (_, i) => `198.51.100.${i + 2}`);

  it('has nothing to say without a trusted proxy (trusted_proxy covers that)', () => {
    const check = buildClientAddressCheck({ requestAddress: '172.18.0.1' });
    expect(check).toMatchObject({ id: 'client_address', ok: true, level: AlertLevel.INFO });
  });

  it('warns when this request arrives as the container’s bridge gateway', () => {
    const check = buildClientAddressCheck({
      trustedProxy: 'x-forwarded-for',
      requestAddress: '172.20.0.1',
      gateways: ['172.20.0.1'],
      recentAddresses: visitors,
    });
    expect(check).toMatchObject({ ok: false, level: AlertLevel.WARNING, detail: { address: '172.20.0.1' } });
    expect(check.message).toMatch(/this request came from it/);
    expect(check.message).toMatch(/userland-proxy/);
    expect(check.message).toMatch(/enable_ipv6/);
  });

  it('recognises the gateway shape without route information, IPv4-mapped too', () => {
    for (const address of ['172.17.0.1', '::ffff:172.18.0.1', '192.168.16.1', '10.0.0.1']) {
      expect(buildClientAddressCheck({ trustedProxy: 'x-forwarded-for', requestAddress: address }).level, address).toBe(
        AlertLevel.WARNING
      );
    }
  });

  it('warns when most recent proxied requests come from one gateway, even if this one does not', () => {
    const recent = [...Array.from({ length: 25 }, () => '172.19.0.1'), ...visitors.slice(0, 5)];
    const check = buildClientAddressCheck({ trustedProxy: 'x-forwarded-for', requestAddress: '203.0.113.9', recentAddresses: recent });
    expect(check).toMatchObject({ ok: false, level: AlertLevel.WARNING, detail: { address: '172.19.0.1', sharedInSample: 25 } });
    expect(check.message).toMatch(/25 of the last 30 requests came from it/);
  });

  it('needs a real sample before the share counts', () => {
    const check = buildClientAddressCheck({ trustedProxy: 'x-forwarded-for', recentAddresses: ['172.19.0.1', '172.19.0.1'] });
    expect(check.ok).toBe(true);
  });

  it('is quiet for real visitors — LAN clients included', () => {
    const check = buildClientAddressCheck({
      trustedProxy: 'cloudflare',
      requestAddress: '192.168.1.23',
      gateways: ['172.20.0.1'],
      recentAddresses: [...visitors, '2001:db8::7', 'unknown'],
    });
    expect(check).toMatchObject({ ok: true, level: AlertLevel.INFO, detail: { sampled: 31, distinct: 31 } });
    expect(isGatewayLikeAddress('192.168.1.23')).toBe(false);
    expect(isGatewayLikeAddress('8.8.8.1')).toBe(false);
    expect(isGatewayLikeAddress('2001:db8::1')).toBe(false);
  });

  it('parses the default gateways out of /proc/net/route', () => {
    const table = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t010014AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
      'eth0\t000014AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
      '',
    ].join('\n');
    expect(parseDefaultGateways(table)).toEqual(['172.20.0.1']);
    expect(parseDefaultGateways('garbage')).toEqual([]);
  });
});

describe('collectDoctorReport wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ getDb: () => ({ execute: vi.fn(async () => [{ ok: 1 }]) }) }));
    vi.doMock('@/lib/redis', () => ({ redis: { ping: vi.fn().mockResolvedValue('PONG') } }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', '');
  });

  afterEach(() => {
    vi.doUnmock('@lobbyforge/db');
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('adds an image_storage warning above the threshold; the report stays ok', async () => {
    vi.doMock('@lobbyforge/db', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@lobbyforge/db')>()),
      getInstanceStoredImageBytes: vi.fn(async () => totals({ totalBytes: 2048 * MB, userBytes: 2000 * MB })),
    }));
    const { collectDoctorReport } = await import('../doctor.js');
    const { report } = await collectDoctorReport();
    expect(report.checks.find((c) => c.id === 'image_storage')).toMatchObject({ ok: false, level: AlertLevel.WARNING });
    expect(report.ok).toBe(true);
  }, 15000);

  it('leaves image_storage out when the totals cannot be read (the postgres check reports that)', async () => {
    vi.doMock('@lobbyforge/db', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@lobbyforge/db')>()),
      getInstanceStoredImageBytes: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { collectDoctorReport } = await import('../doctor.js');
    const { report } = await collectDoctorReport();
    expect(report.checks.find((c) => c.id === 'image_storage')).toBeUndefined();
  }, 15000);

  it('feeds the requesting address and the sampled proxied addresses into client_address', async () => {
    vi.stubEnv('LOBBYFORGE_TRUSTED_PROXY', 'x-forwarded-for');
    const { resolveClientAddress } = await import('../security-headers.js');
    const { __resetClientAddressSample, recentClientAddresses } = await import('../client-address-sample.js');
    __resetClientAddressSample();
    for (let i = 0; i < 24; i += 1) {
      resolveClientAddress(new Request('https://example.test/x', { headers: { 'x-forwarded-for': '172.21.0.1' } }));
    }
    expect(recentClientAddresses()).toHaveLength(24);

    const { collectDoctorReport } = await import('../doctor.js');
    const sampled = await collectDoctorReport();
    expect(sampled.report.checks.find((c) => c.id === 'client_address')).toMatchObject({
      level: AlertLevel.WARNING,
      detail: { address: '172.21.0.1' },
    });

    __resetClientAddressSample();
    const asked = await collectDoctorReport({ clientAddress: '172.17.0.1' });
    expect(asked.report.checks.find((c) => c.id === 'client_address')).toMatchObject({
      level: AlertLevel.WARNING,
      detail: { address: '172.17.0.1' },
    });
    const real = await collectDoctorReport({ clientAddress: '203.0.113.50' });
    expect(real.report.checks.find((c) => c.id === 'client_address')?.ok).toBe(true);
  }, 15000);
});
