/**
 * Security follow-up: fetchIpPinned has a TOTAL deadline and a
 * response-header timeout on top of the socket idle timeout — a server
 * dripping one byte at a time never trips an idle timer. `node:https` is
 * replaced by a scripted fake so the clocks can be tested without TLS.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

type FakeRes = EventEmitter & { statusCode: number };
type FakeReq = EventEmitter & { end: () => void; destroy: (err?: Error) => void; destroyed: boolean };

const script = vi.hoisted(() => ({
  /** Called with the response callback once the request is sent. */
  onEnd: null as null | ((respond: (res: unknown) => void, req: unknown) => void),
  requests: [] as unknown[],
}));

vi.mock('node:https', () => {
  function request(_url: string, _opts: unknown, callback: (res: unknown) => void) {
    const req = new EventEmitter() as FakeReq;
    req.destroyed = false;
    req.destroy = (err?: Error) => {
      if (req.destroyed) return;
      req.destroyed = true;
      if (err) queueMicrotask(() => req.emit('error', err));
    };
    req.end = () => script.onEnd?.(callback, req);
    script.requests.push(req);
    return req;
  }
  return { request, Agent: vi.fn(function Agent() {}) };
});

import { fetchIpPinned } from '../ip-pinned-https';

const timers: Array<ReturnType<typeof setInterval>> = [];
afterEach(() => {
  for (const t of timers.splice(0)) clearInterval(t);
  script.onEnd = null;
  script.requests.length = 0;
});

function respondWith(statusCode = 200): FakeRes {
  const res = new EventEmitter() as FakeRes;
  res.statusCode = statusCode;
  return res;
}

describe('fetchIpPinned clocks', () => {
  it('resolves a normal response', async () => {
    script.onEnd = (respond) => {
      const res = respondWith(200);
      respond(res);
      res.emit('data', Buffer.from('hello'));
      res.emit('end');
    };
    const result = await fetchIpPinned('https://example.test/x', 'example.test', ['93.184.216.34']);
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(result.body.toString()).toBe('hello');
  });

  it('gives up on a slow drip at the total deadline even though bytes keep arriving', async () => {
    script.onEnd = (respond) => {
      const res = respondWith(200);
      respond(res);
      // One byte every 20 ms: the idle timer (1 s) never fires.
      timers.push(setInterval(() => res.emit('data', Buffer.from('x')), 20));
    };
    const started = Date.now();
    await expect(
      fetchIpPinned('https://example.test/x', 'example.test', ['93.184.216.34'], {
        timeoutMs: 1_000,
        totalTimeoutMs: 150,
      })
    ).rejects.toThrow('Request exceeded the 150 ms deadline');
    expect(Date.now() - started).toBeLessThan(900);
    expect((script.requests[0] as FakeReq).destroyed).toBe(true);
  });

  it('fails when no response headers arrive in time', async () => {
    script.onEnd = () => {
      /* the server accepts the request and never answers */
    };
    await expect(
      fetchIpPinned('https://example.test/x', 'example.test', ['93.184.216.34'], {
        timeoutMs: 5_000,
        headersTimeoutMs: 50,
      })
    ).rejects.toThrow('No response headers within 50 ms');
    expect((script.requests[0] as FakeReq).destroyed).toBe(true);
  });

  it('defaults the total deadline to three times the idle timeout', async () => {
    script.onEnd = (respond) => {
      const res = respondWith(200);
      respond(res);
      timers.push(setInterval(() => res.emit('data', Buffer.from('x')), 10));
    };
    await expect(
      fetchIpPinned('https://example.test/x', 'example.test', ['93.184.216.34'], { timeoutMs: 40 })
    ).rejects.toThrow('Request exceeded the 120 ms deadline');
  });

  it('stops when the caller aborts', async () => {
    script.onEnd = () => {
      /* hang */
    };
    const controller = new AbortController();
    const pending = fetchIpPinned('https://example.test/x', 'example.test', ['93.184.216.34'], {
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow('Request aborted');
    await expect(
      fetchIpPinned('https://example.test/x', 'example.test', ['93.184.216.34'], { signal: controller.signal })
    ).rejects.toThrow('Request aborted');
  });

  it('still enforces the byte cap', async () => {
    script.onEnd = (respond) => {
      const res = respondWith(200);
      respond(res);
      res.emit('data', Buffer.alloc(64));
    };
    await expect(
      fetchIpPinned('https://example.test/x', 'example.test', ['93.184.216.34'], { maxStreamBytes: 10 })
    ).rejects.toThrow('Download exceeds the 10 byte cap');
  });
});

/**
 * Bot event endpoints (security review, "needs verification"): their host
 * names come from bots, so a stalling authoritative server must not pin a
 * libuv threadpool thread (shared with scrypt) for the system resolver's
 * whole retry schedule. With `timeoutMs` the names are asked with the
 * c-ares resolver (own sockets) and the answer must come in time.
 */
describe('resolvePublicAddresses with a deadline', () => {
  function fakeResolver(answers: { v4?: () => Promise<string[]>; v6?: () => Promise<string[]> }) {
    const cancel = vi.fn();
    const created: number[] = [];
    const createResolver = (timeoutMs: number) => {
      created.push(timeoutMs);
      return {
        resolve4: vi.fn(answers.v4 ?? (async () => [])),
        resolve6: vi.fn(answers.v6 ?? (async () => Promise.reject(Object.assign(new Error('no AAAA'), { code: 'ENODATA' })))),
        cancel,
      };
    };
    return { createResolver, cancel, created };
  }

  it('gives up at the deadline and cancels the outstanding queries', async () => {
    const { resolvePublicAddresses, PublicAddressError } = await import('../ip-pinned-https');
    const never = () => new Promise<string[]>(() => {});
    const fake = fakeResolver({ v4: never, v6: never });
    const started = Date.now();
    const error = await resolvePublicAddresses('stall.example.com', { timeoutMs: 40, createResolver: fake.createResolver }).catch((e) => e);
    expect(error).toBeInstanceOf(PublicAddressError);
    expect(error).toMatchObject({ reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fake.cancel).toHaveBeenCalledTimes(1);
    expect(fake.created).toEqual([40]);
  });

  it('returns A and AAAA answers; a family without records is fine', async () => {
    const { resolvePublicAddresses } = await import('../ip-pinned-https');
    const both = fakeResolver({ v4: async () => ['93.184.216.34'], v6: async () => ['2606:2800:220:1::248'] });
    expect(await resolvePublicAddresses('bot.example.com', { timeoutMs: 2_000, createResolver: both.createResolver })).toEqual([
      '93.184.216.34',
      '2606:2800:220:1::248',
    ]);
    const v4only = fakeResolver({ v4: async () => ['93.184.216.34'] });
    expect(await resolvePublicAddresses('bot.example.com', { timeoutMs: 2_000, createResolver: v4only.createResolver })).toEqual(['93.184.216.34']);
  });

  it('still refuses private answers, local names and unresolvable hosts — with a reason code, the detail only in the message', async () => {
    const { resolvePublicAddresses } = await import('../ip-pinned-https');
    const rebind = fakeResolver({ v4: async () => ['93.184.216.34', '10.0.0.5'] });
    await expect(resolvePublicAddresses('evil.example.com', { timeoutMs: 2_000, createResolver: rebind.createResolver })).rejects.toMatchObject({
      reason: 'blocked_address',
    });
    const missing = fakeResolver({ v4: async () => Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })) });
    await expect(resolvePublicAddresses('nx.example.com', { timeoutMs: 2_000, createResolver: missing.createResolver })).rejects.toMatchObject({
      reason: 'unresolvable',
    });
    const unused = fakeResolver({});
    await expect(resolvePublicAddresses('localhost', { timeoutMs: 2_000, createResolver: unused.createResolver })).rejects.toMatchObject({
      reason: 'local_name',
    });
    expect(unused.created).toEqual([]);
  });

  it('an IP literal is judged as it is — no DNS query at all', async () => {
    const { resolvePublicAddresses } = await import('../ip-pinned-https');
    const unused = fakeResolver({});
    expect(await resolvePublicAddresses('93.184.216.34', { timeoutMs: 2_000, createResolver: unused.createResolver })).toEqual(['93.184.216.34']);
    await expect(resolvePublicAddresses('169.254.169.254', { timeoutMs: 2_000, createResolver: unused.createResolver })).rejects.toMatchObject({
      reason: 'blocked_address',
    });
    expect(unused.created).toEqual([]);
  });
});
