/**
 * The SMTP host rules (docs/EMAIL.md §3.4). An admin-entered SMTP host is
 * an SSRF surface: the admin is trusted, but a stolen admin session (or a
 * typo) must not turn the mail test into a port scanner of the private
 * network or a reader of a cloud metadata service.
 *
 *   - ports: 25, 465, 587, 2465, 2525, 2587 — plus the mailpit ports in
 *     development (1025 inside compose, 19525 on the dev host);
 *   - link-local and metadata addresses (169.254.0.0/16, fe80::/10,
 *     fd00:ec2::254) are refused everywhere, judged on the RESOLVED
 *     addresses;
 *   - loopback and private ranges are refused in production, except the
 *     compose service name `mailpit` on an instance that is not the
 *     official hub (`isBlockedNetworkIp`, the plugin installer's policy);
 *   - `none` security (no TLS at all) only for localhost or mailpit.
 *     Certificate verification itself cannot be turned off (the transport
 *     always verifies).
 *
 * `checkSmtpTarget` resolves the host ONCE and returns the addresses it
 * allowed: the transport connects to one of them (with the hostname as
 * TLS server name), so a DNS answer that changes between this check and
 * the connection cannot slip in another address.
 */
import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';
import { isBlockedNetworkIp, parseIp } from '@/lib/ip-ranges';
import { ALLOWED_SMTP_PORTS, DEVELOPMENT_SMTP_PORT, type MailTestDetail, type SmtpSecurity } from './types';

/** mailpit on the dev host (docker-compose.dev.yml maps 19525 → 1025). */
export const DEV_HOST_MAILPIT_PORT = 19525;
export const MAILPIT_SERVICE_HOST = 'mailpit';
const DNS_TIMEOUT_MS = 5_000;
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.?$/i;

export interface SmtpTargetContext {
  production: boolean;
  official: boolean;
}

export type SmtpTargetCheck =
  | { ok: true; host: string; addresses: string[] }
  | { ok: false; detail: Extract<MailTestDetail, 'port_not_allowed' | 'address_not_allowed' | 'security_not_allowed' | 'invalid_host' | 'host_not_found'> };

function normaliseHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  // [::1] → ::1
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host.replace(/\.$/, '');
}

/** May this port be used here? */
export function smtpPortAllowed(port: number, host: string, context: SmtpTargetContext): boolean {
  if (ALLOWED_SMTP_PORTS.includes(port)) return true;
  if (port === DEVELOPMENT_SMTP_PORT || port === DEV_HOST_MAILPIT_PORT) {
    if (!context.production) return true;
    return port === DEVELOPMENT_SMTP_PORT && host === MAILPIT_SERVICE_HOST && !context.official;
  }
  return false;
}

/** A syntactically valid host name or IP literal (no scheme, path, port or spaces). */
export function smtpHostSyntaxOk(raw: string): boolean {
  const host = normaliseHost(raw);
  if (!host) return false;
  if (isIP(host)) return true;
  return HOSTNAME.test(host);
}

function isLoopbackHostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

const LINK_LOCAL_V4 = { base: (169n << 24n) | (254n << 16n), bits: 16 };
const EC2_METADATA_V6 = parseIp('fd00:ec2::254')!.value;

function inV4(value: bigint, cidr: { base: bigint; bits: number }): boolean {
  const mask = ((1n << BigInt(cidr.bits)) - 1n) << BigInt(32 - cidr.bits);
  return (value & mask) === (cidr.base & mask);
}

/** Link-local or a cloud metadata address, in any notation (IPv4-mapped included). Unparseable → true (fail closed). */
export function isLinkLocalOrMetadata(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return true;
  if (parsed.version === 4) return inV4(parsed.value, LINK_LOCAL_V4);
  if (parsed.value === EC2_METADATA_V6) return true;
  // fe80::/10
  if (parsed.value >> 118n === 0x3fan) return true;
  // IPv4-mapped / -translated forms of 169.254.x.x
  const upper = (parsed.value >> 32n) & 0xffffffffffffffffn;
  if (upper === 0xffffn || upper === 0xffff_0000n) return inV4(parsed.value & 0xffffffffn, LINK_LOCAL_V4);
  return false;
}

function isLoopbackIp(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  if (parsed.version === 4) return parsed.value >> 24n === 127n;
  return parsed.value === 1n;
}

async function resolveAll(host: string): Promise<string[] | null> {
  if (isIP(host)) return [host];
  let timer: NodeJS.Timeout | undefined;
  try {
    const answers = await Promise.race([
      dnsPromises.lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    const addresses = answers.map((answer) => answer.address);
    return addresses.length ? addresses : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Check a host/port/security triple against §3.4 and resolve it. On
 * success the allowed addresses come back IPv4 first (what the transport
 * connects to).
 */
export async function checkSmtpTarget(
  input: { host: string; port: number; security: SmtpSecurity },
  context: SmtpTargetContext,
  resolve: (host: string) => Promise<string[] | null> = resolveAll
): Promise<SmtpTargetCheck> {
  if (!smtpHostSyntaxOk(input.host)) return { ok: false, detail: 'invalid_host' };
  const host = normaliseHost(input.host);
  if (!Number.isInteger(input.port) || !smtpPortAllowed(input.port, host, context)) return { ok: false, detail: 'port_not_allowed' };
  const mailpitService = host === MAILPIT_SERVICE_HOST && !context.official;

  const addresses = await resolve(host);
  if (!addresses) return { ok: false, detail: 'host_not_found' };

  for (const address of addresses) {
    if (isLinkLocalOrMetadata(address)) return { ok: false, detail: 'address_not_allowed' };
    if (context.production && !mailpitService && isBlockedNetworkIp(address)) return { ok: false, detail: 'address_not_allowed' };
  }

  if (input.security === 'none') {
    const local = isLoopbackHostName(host) || mailpitService || addresses.every(isLoopbackIp);
    if (!local) return { ok: false, detail: 'security_not_allowed' };
  }

  const ordered = [...addresses.filter((a) => isIP(a) === 4), ...addresses.filter((a) => isIP(a) === 6)];
  return { ok: true, host, addresses: ordered };
}

/**
 * The checks that need no DNS (the admin PUT validates with these; the
 * resolved-address checks run on every connection and in the test).
 */
export function staticSmtpTargetRefusal(
  input: { host: string; port: number; security: SmtpSecurity },
  context: SmtpTargetContext
): SmtpTargetCheck | null {
  if (!smtpHostSyntaxOk(input.host)) return { ok: false, detail: 'invalid_host' };
  const host = normaliseHost(input.host);
  if (!smtpPortAllowed(input.port, host, context)) return { ok: false, detail: 'port_not_allowed' };
  if (isIP(host) && isLinkLocalOrMetadata(host)) return { ok: false, detail: 'address_not_allowed' };
  if (isIP(host) && context.production && isBlockedNetworkIp(host)) return { ok: false, detail: 'address_not_allowed' };
  if (input.security === 'none') {
    const local = isLoopbackHostName(host) || (host === MAILPIT_SERVICE_HOST && !context.official) || (isIP(host) > 0 && isLoopbackIp(host));
    if (!local) return { ok: false, detail: 'security_not_allowed' };
  }
  return null;
}
