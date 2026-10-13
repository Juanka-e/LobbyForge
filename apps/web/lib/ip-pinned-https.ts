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
import { isIP } from 'node:net';
import { promises as dnsPromises } from 'node:dns';
import { isBlockedNetworkIp } from './ip-ranges';

/**
 * Why a host was not accepted as a public target. `message` carries the
 * detail (the resolver's error, the refused address) for the SERVER LOG
 * only: a caller that answers someone outside (the Bot API endpoint save)
 * maps every reason to one generic sentence (security review BOT-004).
 */
export class PublicAddressError extends Error {
  constructor(
    readonly reason: 'local_name' | 'unresolvable' | 'blocked_address' | 'timeout',
    message: string
  ) {
    super(message);
    this.name = 'PublicAddressError';
  }
}

/** The c-ares resolver, async on its own sockets — no libuv threadpool. */
export interface DeadlineResolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  cancel(): void;
}

export interface ResolveOptions {
  /**
   * Bound the whole resolution. Without it the system resolver is used
   * (`dns.lookup` → getaddrinfo on the libuv threadpool, which honours
   * /etc/hosts), unchanged for the installer / directory / CAPTCHA callers.
   * With it the names are asked over DNS with c-ares (`dns.Resolver`:
   * own sockets, never a threadpool thread) and the answer must come
   * within `timeoutMs`; a stalling authoritative server then costs one
   * cancelled query, not a threadpool thread for the resolver's whole
   * retry schedule (the pool is shared with scrypt, zlib and file I/O).
   * Event deliveries use this — their host names come from bots.
   */
  timeoutMs?: number;
  /** Test seam: the resolver used with `timeoutMs`. */
  createResolver?: (timeoutMs: number) => DeadlineResolver;
}

function defaultResolver(timeoutMs: number): DeadlineResolver {
  // One try per server; `timeout` is per query. The overall deadline below
  // still applies when /etc/resolv.conf lists several servers.
  return new dnsPromises.Resolver({ timeout: timeoutMs, tries: 1 });
}

const NO_RECORDS = new Set(['ENODATA', 'ENOTFOUND', 'ENONAME', 'NOTFOUND', 'NODATA']);

async function resolveWithDeadline(host: string, options: Required<Pick<ResolveOptions, 'timeoutMs'>> & ResolveOptions): Promise<string[]> {
  const resolver = (options.createResolver ?? defaultResolver)(options.timeoutMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      resolver.cancel();
      reject(new PublicAddressError('timeout', `DNS resolution of ${JSON.stringify(host)} exceeded ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    timer.unref?.();
  });
  const lookup = Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]).then(([v4, v6]) => {
    const addresses = [
      ...(v4.status === 'fulfilled' ? v4.value : []),
      ...(v6.status === 'fulfilled' ? v6.value : []),
    ];
    if (addresses.length > 0) return addresses;
    // Neither family answered: say why (the first real error wins over "no records").
    const errors = [v4, v6]
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason as NodeJS.ErrnoException);
    const real = errors.find((e) => !NO_RECORDS.has(String(e?.code)));
    throw new PublicAddressError('unresolvable', `Could not resolve ${JSON.stringify(host)}: ${(real ?? errors[0])?.code ?? 'no addresses'}`);
  });
  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolve a hostname and refuse private/loopback targets. */
export async function resolvePublicAddresses(host: string, options: ResolveOptions = {}): Promise<string[]> {
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new PublicAddressError('local_name', 'Target must not point at a local name');
  }
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else if (options.timeoutMs !== undefined) {
    addresses = await resolveWithDeadline(host, { ...options, timeoutMs: options.timeoutMs });
  } else {
    const result = await dnsPromises.lookup(host, { all: true });
    addresses = result.map((r) => r.address);
  }
  if (addresses.length === 0) throw new PublicAddressError('unresolvable', `Could not resolve hostname: ${host}`);
  for (const ip of addresses) {
    if (isBlockedNetworkIp(ip)) {
      throw new PublicAddressError('blocked_address', `Target resolves to a blocked address: ${ip}`);
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
