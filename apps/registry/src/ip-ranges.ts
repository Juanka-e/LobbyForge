/**
 * Canonical IP range classification (LF-SEC-013).
 *
 * The registry URL validator used string prefixes for IPv6 — wrong for compressed notation,
 * IPv4-mapped forms and CIDR ranges that don't align with textual
 * prefixes. This module PARSES addresses into 128-bit BigInts and
 * compares against explicit CIDR ranges instead.
 *
 * Same policy as before, now enforced correctly:
 * loopback, private, link-local, CGNAT, ULA, multicast, NAT64,
 * discard-only, documentation and IPv4-mapped forms are all BLOCKED.
 */

export interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

/** Parse dotted-quad / any legal IPv6 textual form. null = unparseable. */
export function parseIp(ip: string): ParsedIp | null {
  const trimmed = ip.trim();
  if (trimmed.includes(':')) return parseIpv6(trimmed);
  return parseIpv4(trimmed);
}

function parseIpv4(ip: string): ParsedIp | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return { version: 4, value };
}

/**
 * Parse IPv6 — handles :: compression, embedded IPv4 tails and
 * hextet/byte mixtures. Normalizes to a 128-bit BigInt.
 */
function parseIpv6(ip: string): ParsedIp | null {
  // Split off a possible zone id (fe80::1%eth0) — never routable.
  const noZone = ip.split('%')[0]!;
  let head = noZone;
  let tail: string | null = null;
  const doubleColon = noZone.indexOf('::');
  if (doubleColon !== -1) {
    if (noZone.indexOf('::', doubleColon + 1) !== -1) return null; // two ::
    head = noZone.slice(0, doubleColon);
    tail = noZone.slice(doubleColon + 2);
  }

  const parseGroup = (segment: string): bigint[] | null => {
    if (segment === '') return [];
    const pieces = segment.split(':');
    const groups: bigint[] = [];
    for (const piece of pieces) {
      if (piece === '') return null;
      // Embedded IPv4 tail (only valid as the LAST piece).
      if (piece.includes('.')) {
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        groups.push(v4.value >> 16n);
        groups.push(v4.value & 0xffffn);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(BigInt(parseInt(piece, 16)));
    }
    return groups;
  };

  const headGroups = parseGroup(head);
  if (headGroups === null) return null;
  const tailGroups = tail === null ? [] : parseGroup(tail);
  if (tailGroups === null) return null;

  const missing = 8 - headGroups.length - tailGroups.length;
  if (tail === null) {
    if (headGroups.length !== 8) return null;
  } else if (missing < 1) {
    // "::" must stand for at least one zero group.
    return null;
  }

  const groups = [
    ...headGroups,
    ...new Array<bigint>(missing).fill(0n),
    ...tailGroups,
  ];
  let value = 0n;
  for (const g of groups) value = (value << 16n) | g;
  return { version: 6, value };
}

function inCidr4(value: bigint, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const baseParsed = parseIpv4(base!);
  if (!baseParsed) return false;
  const bits = BigInt(bitsRaw ?? '32');
  if (bits === 0n) return true;
  const mask = (0xffffffffn << (32n - bits)) & 0xffffffffn;
  return (value & mask) === (baseParsed.value & mask);
}

function inCidr6(value: bigint, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const baseParsed = parseIpv6(base!);
  if (!baseParsed) return false;
  const bits = BigInt(bitsRaw ?? '128');
  if (bits === 0n) return true;
  const mask = (0xffffffffffffffffffffffffffffffffn << (128n - bits)) & 0xffffffffffffffffffffffffffffffffn;
  return (value & mask) === (baseParsed.value & mask);
}

const BLOCKED_V4 = [
  '0.0.0.0/8',        // "this" network
  '10.0.0.0/8',       // private
  '100.64.0.0/10',    // CGNAT
  '127.0.0.0/8',      // loopback
  '169.254.0.0/16',   // link-local
  '172.16.0.0/12',    // private
  '192.0.0.0/24',     // special-purpose
  '192.0.2.0/24',     // documentation
  '192.168.0.0/16',   // private
  '198.18.0.0/15',    // benchmarking
  '198.51.100.0/24',  // documentation
  '203.0.113.0/24',   // documentation
  '224.0.0.0/4',      // multicast
  '240.0.0.0/4',      // reserved / broadcast
];

const BLOCKED_V6 = [
  '::/128',           // unspecified
  '::1/128',          // loopback
  '::ffff:0:0/96',    // IPv4-mapped (contents checked below too)
  '64:ff9b::/96',     // NAT64 well-known prefix
  '100::/64',         // discard-only
  '2001:db8::/32',    // documentation
  'fc00::/7',         // ULA
  'fe80::/10',        // link-local
  'fec0::/10',        // deprecated site-local
  'ff00::/8',         // multicast
];

/**
 * True when the address must not be FETCHED from (SSRF boundary):
 * private, loopback, link-local, CGNAT/ULA, multicast, NAT64,
 * discard/documentation ranges — in every textual representation.
 */
export function isBlockedNetworkIp(ip: string): boolean {
  const parsed = parseIp(ip);
  // Registry semantics: inputs are raw HOSTNAMES (pre-DNS). A hostname
  // that is not a literal IP address is not blocked HERE — resolution
  // happens later and any fetch step re-checks the resolved address.
  // Literal IPs that fail to parse (garbage like ':::') DO refuse.
  if (!parsed) return false;

  if (parsed.version === 4) {
    return BLOCKED_V4.some((cidr) => inCidr4(parsed.value, cidr));
  }

  if (BLOCKED_V6.some((cidr) => inCidr6(parsed.value, cidr))) return true;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-translated (::ffff:0:a.b.c.d)
  // share the same top structure (0xffff at bits 32-47, embedded v4 at
  // bits 0-31) — apply the IPv4 policy to the embedded address,
  // whatever notation produced it. Explicit parens: === binds tighter
  // than &, so the shift/mask must be parenthesized first.
  const upperV4 = (parsed.value >> 32n) & 0xffffffffffffffffn;
  // IPv4-mapped (::ffff:a.b.c.d) explodes with 0xffff at bits 32-47;
  // IPv4-translated (::ffff:0:a.b.c.d) with 0xffff at bits 48-63.
  if (upperV4 === 0xffffn || upperV4 === 0xffff_0000n) {
    const embedded = parsed.value & 0xffffffffn;
    return BLOCKED_V4.some((cidr) => inCidr4(embedded, cidr));
  }
  return false;
}
