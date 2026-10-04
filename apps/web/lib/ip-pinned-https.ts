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
 *
 * Three clocks (security follow-up): `timeoutMs` is the socket IDLE
 * timeout, which a server dripping one byte at a time never trips;
 * `headersTimeoutMs` (default `timeoutMs`) bounds the wait for the
 * response headers; `totalTimeoutMs` (default 3 × `timeoutMs`) is a hard
 * deadline for the whole request, body included. A caller `signal`
 * aborts it early.
 */
export async function fetchIpPinned(
  url: string,
  originalHostname: string,
  verifiedAddresses: string[],
  options: {
    timeoutMs?: number;
    headersTimeoutMs?: number;
    totalTimeoutMs?: number;
    signal?: AbortSignal;
    maxStreamBytes?: number;
    userAgent?: string;
    /**
     * Bot API v2 event deliveries POST a signed JSON body. GET without a
     * body stays the default, so the installer / directory callers are
     * unchanged. Redirects are never followed either way (`https.request`
     * does not), so a 3xx cannot bounce a request to an unchecked host.
     */
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string | Buffer;
  } = {}
): Promise<{ ok: boolean; status: number; body: Buffer; arrayBuffer: ArrayBuffer }> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const headersTimeoutMs = options.headersTimeoutMs ?? timeoutMs;
  const totalTimeoutMs = options.totalTimeoutMs ?? timeoutMs * 3;
  const maxStreamBytes = options.maxStreamBytes ?? 16 * 1024 * 1024;
  if (options.signal?.aborted) throw new Error('Request aborted');
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
  const deadline = AbortSignal.timeout(totalTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    let headersTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (headersTimer) clearTimeout(headersTimer);
      headersTimer = null;
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (err: Error) => {
      cleanup();
      req.destroy(err);
      reject(err);
    };
    const onAbort = () => {
      fail(
        deadline.aborted
          ? new Error(`Request exceeded the ${totalTimeoutMs} ms deadline`)
          : new Error('Request aborted')
      );
    };
    const req = https.request(
      url,
      {
        agent,
        timeout: timeoutMs,
        method: options.method ?? 'GET',
        headers: {
          ...(options.headers ?? {}),
          'user-agent': options.userAgent ?? 'LobbyForge/1.0',
          ...(options.body !== undefined ? { 'content-length': String(Buffer.byteLength(options.body)) } : {}),
        },
      },
      (res) => {
        if (headersTimer) clearTimeout(headersTimer);
        headersTimer = null;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxStreamBytes) {
            fail(new Error(`Download exceeds the ${maxStreamBytes} byte cap`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          cleanup();
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
        res.on('error', (err: Error) => fail(err));
      }
    );
    headersTimer = setTimeout(
      () => fail(new Error(`No response headers within ${headersTimeoutMs} ms`)),
      headersTimeoutMs
    );
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => fail(new Error('Request timed out')));
    req.on('error', (err: Error) => {
      cleanup();
      reject(err);
    });
    if (options.body !== undefined) req.end(options.body);
    else req.end();
  });
}
