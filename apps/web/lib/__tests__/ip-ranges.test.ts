/**
 * LF-SEC-013: canonical IP/CIDR classification — the audit's required
 * test table. Every address below must be classified by PARSED ranges,
 * not textual prefixes (compressed IPv6, embedded IPv4, odd forms).
 */
import { describe, expect, it } from 'vitest';
import { isBlockedNetworkIp, parseIp } from '../ip-ranges';

describe('isBlockedNetworkIp — IPv4', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.1.1',
    '100.64.0.1',
    '0.0.0.5',
    '192.0.0.9',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
  ])('blocks %s', (ip) => {
    expect(isBlockedNetworkIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',  // just outside 172.16/12
    '172.15.255.255',
    '100.128.0.1', // just outside CGNAT 100.64/10
    '192.169.0.1',
    '203.0.114.1', // one past the documentation range
  ])('allows public %s', (ip) => {
    expect(isBlockedNetworkIp(ip)).toBe(false);
  });
});

describe('isBlockedNetworkIp — IPv6', () => {
  it.each([
    '::1',
    '::',
    'fe80::1',
    'fe90::1',
    'fea0::1',
    'febf::1',     // last address of fe80::/10
    'fc00::1',
    'fd00::1',
    'ff02::1',
    '2001:db8::dead:beef',
    '64:ff9b::1.2.3.4',
    '100::dead',
    'fec0::1',
    // IPv4-mapped — in every notation
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:192.168.1.1',
    '::ffff:169.254.1.1',
    '0:0:0:0:0:ffff:7f00:1',   // expanded-hex 127.0.0.1
    '::ffff:0:0.0.0.1',        // IPv4-translated family (::ffff:0:0/96)
    '::ffff:0:1',              // translated, compressed differently
  ])('blocks %s', (ip) => {
    expect(isBlockedNetworkIp(ip)).toBe(true);
  });

  it.each([
    '2606:4700:4700::1111',    // public (Cloudflare DNS)
    '2a00:1450:4001:81b::200e',// public (Google)
    '2620:fe::fe',             // public (Quad9)
  ])('allows public %s', (ip) => {
    expect(isBlockedNetworkIp(ip)).toBe(false);
  });
});

describe('parseIp normalization', () => {
  it('compressed and expanded IPv6 forms parse to the same value', () => {
    expect(parseIp('::1')!.value).toBe(parseIp('0:0:0:0:0:0:0:1')!.value);
    expect(parseIp('fe80::1')!.value).toBe(parseIp('fe80:0:0:0:0:0:0:1')!.value);
    expect(parseIp('::ffff:192.168.1.1')!.value).toBe(
      parseIp('0:0:0:0:0:ffff:c0a8:101')!.value
    );
  });

  it('rejects malformed addresses', () => {
    expect(parseIp('not-an-ip')).toBeNull();
    expect(parseIp('192.168.1.256')).toBeNull();
    expect(parseIp('192.168.1')).toBeNull();
    expect(parseIp('::1::2')).toBeNull();
    expect(parseIp('fe80:::1')).toBeNull();
  });

  it('unparseable addresses are BLOCKED (fail closed)', () => {
    expect(isBlockedNetworkIp('garbage')).toBe(true);
  });
});
