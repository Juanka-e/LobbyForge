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
