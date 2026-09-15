/**
 * Shared IP-pinned HTTPS transport (14th-audit).
 *
 * ONE implementation for the plugin installer, the marketplace
 * review-time bundle fetch and the directory's .well-known domain
 * verification — the directory's private copy had a Node-22 lookup
 * incompatibility (autoSelectFamily passes all:true and expects an
 * array of {address, family}; the copy returned a bare string, so the
 * verified-IP pinning silently misbehaved on modern Node).
 */
import * as https from 'node:https';
import { promises as dnsPromises } from 'node:dns';
import { isBlockedNetworkIp } from './ip-ranges';

/** Resolve a hostname and refuse private/loopback targets. */
export async function resolvePublicAddresses(host: string): Promise<string[]> {
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Target must not point at a local name');
  }
  const result = await dnsPromises.lookup(host, { all: true });
  const addresses = result.map((r) => r.address);
  if (addresses.length === 0) throw new Error(`Could not resolve hostname: ${host}`);
  for (const ip of addresses) {
    if (isBlockedNetworkIp(ip)) {
      throw new Error(`Target resolves to a blocked address: ${ip}`);
    }
  }
  return addresses;
}

/**
 * IP-pinned HTTPS fetch: DNS resolution returns ONLY the pre-verified
 * addresses (a rebind between check and connect cannot reach an
 * internal service); SNI/certificate validation keep the real hostname
 * via servername. The lookup callback answers Node-22's autoSelectFamily
 * shape ({address, family} objects) on every code path.
 */
export async function fetchIpPinned(
  url: string,
  originalHostname: string,
  verifiedAddresses: string[],
  options: { timeoutMs?: number; maxStreamBytes?: number; userAgent?: string } = {}
): Promise<{ ok: boolean; status: number; body: Buffer; arrayBuffer: ArrayBuffer }> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxStreamBytes = options.maxStreamBytes ?? 16 * 1024 * 1024;
  const lookupFn = (
    _hostname: string,
    _opts: unknown,
    callback: (err: Error | null, addresses: unknown) => void
  ) => {
    callback(
      null,
      verifiedAddresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    );
  };
  const agent = new https.Agent({
    lookup: lookupFn as never,
    servername: originalHostname,
  });
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    const req = https.request(
      url,
      {
        agent,
        timeout: timeoutMs,
        headers: { 'user-agent': options.userAgent ?? 'LobbyForge/1.0' },
      },
      (res) => {
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxStreamBytes) {
            req.destroy(new Error(`Download exceeds the ${maxStreamBytes} byte cap`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
            status: res.statusCode ?? 500,
            body,
            arrayBuffer: body.buffer.slice(
              body.byteOffset,
              body.byteOffset + body.byteLength
            ) as ArrayBuffer,
          });
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}
