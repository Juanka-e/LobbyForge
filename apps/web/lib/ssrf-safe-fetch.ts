/**
 * SSRF-safe HTTPS GET for server-side fetches to instance domains
 * (12th-audit: the .well-known directory verification).
 *
 * Extracted from the plugin installer's battle-tested pattern:
 *   1. hostname string checks (localhost/.local/.internal);
 *   2. DNS resolve — EVERY address must be public (rebinding check);
 *   3. the connection is PINNED to the verified IPs via https.request
 *      with a custom `lookup` (a plain fetch re-resolves and could be
 *      rebound between check and connect);
 *   4. SNI + certificate validation keep the ORIGINAL hostname.
 */
import * as https from 'node:https';
import { promises as dnsPromises } from 'node:dns';
import { isBlockedNetworkIp } from './ip-ranges';

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;

/** Resolve a hostname and refuse private/loopback targets. */
async function resolvePublicAddresses(host: string): Promise<string[]> {
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
 * IP-pinned HTTPS GET. Returns the body (capped); throws on SSRF
 * violations, DNS failures, timeouts or TLS errors.
 */
export function ssrfSafeGet(
  url: string,
  options: { timeoutMs?: number; maxBodyBytes?: number } = {}
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  return new Promise<SafeFetchResult>((resolve, reject) => {
    void (async () => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        reject(new Error('Invalid URL'));
        return;
      }
      if (parsed.protocol !== 'https:') {
        reject(new Error('Only HTTPS targets are allowed'));
        return;
      }

      let addresses: string[];
      try {
        addresses = await resolvePublicAddresses(parsed.hostname);
      } catch (err) {
        reject(err);
        return;
      }

      const req = https.request(
        url,
        {
          method: 'GET',
          timeout: timeoutMs,
          // PIN to the verified addresses; SNI/cert keep the hostname.
          lookup: (_hostname, _opts, cb) => {
            cb(null, addresses[0]!);
          },
          servername: parsed.hostname,
          headers: { 'user-agent': 'LobbyForge-Directory/1.0' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > maxBodyBytes) {
              req.destroy();
              reject(new Error('Response body exceeds the size cap'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            resolve({
              ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
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
    })();
  });
}
