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

// Security follow-up: IPv4-compatible (::/96) and 6to4 (2002::/16).
describe('isBlockedNetworkIp — IPv4-compatible and 6to4', () => {
  it.each([
    '::127.0.0.1',             // IPv4-compatible loopback
    '::7f00:1',                // same, hex
    '::10.0.0.1',              // IPv4-compatible private
    '::8.8.8.8',               // the whole deprecated ::/96 range is refused
    '2002:7f00:1::',           // 6to4 → 127.0.0.1
    '2002:7f00:0001:0:0:0:0:1',
    '2002:a00:1::1',           // 6to4 → 10.0.0.1
    '2002:c0a8:101::1',        // 6to4 → 192.168.1.1
    '2002:a9fe:a9fe::',        // 6to4 → 169.254.169.254 (cloud metadata)
    '2002:6440:1::',           // 6to4 → 100.64.0.1 (CGNAT)
    '2002::',                  // 6to4 → 0.0.0.0
  ])('blocks %s', (ip) => {
    expect(isBlockedNetworkIp(ip)).toBe(true);
  });

  it.each([
    '2002:808:808::1',         // 6to4 → 8.8.8.8 (public)
    '2002:5db8:d822::',        // 6to4 → 93.184.216.34 (public)
    '2003::1',                 // just outside 2002::/16
  ])('allows %s', (ip) => {
    expect(isBlockedNetworkIp(ip)).toBe(false);
  });
});

describe('isBlockedNetworkIp — Teredo and local-use NAT64', () => {
  it.each([
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo (2001::/32) — embedded IPv4 is obfuscated
    '2001::1',
    '64:ff9b:1::a00:1',                     // local-use NAT64 (RFC 8215)
  ])('blocks %s', (ip) => {
    expect(isBlockedNetworkIp(ip)).toBe(true);
  });

  it.each([
    '2001:4860:4860::8888',                 // public 2001:: space outside Teredo
    '2001:1::1',                            // 2001:0001::/32 is not Teredo
  ])('allows %s', (ip) => {
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
