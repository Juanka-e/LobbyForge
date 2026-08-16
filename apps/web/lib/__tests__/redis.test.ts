/**
 * Tests for the Redis-backed presence/bandwidth/typing helpers in lib/redis.ts.
 *
 * We mock ioredis so the tests don't need a real Redis. The mock records
 * pipeline/scan/mget/get/set/del calls so assertions can verify key shapes
 * and TTL behavior deterministically.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const pipelineCommands: Array<{ cmd: string; args: unknown[] }> = [];
let pipelineExec: () => Promise<unknown> = async () => [];

const store = new Map<string, string>();
const mgetImpl = vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null));
// redis.scan must return [cursor, batch]; cursor '0' ends the loop.
const scanImpl = vi.fn(async () => ['0', []] as [string, string[]]);

function makePipeline() {
  return {
    incrbyfloat(key: string, delta: number) {
      pipelineCommands.push({ cmd: 'incrbyfloat', args: [key, delta] });
    },
    expire(key: string, ttl: number) {
      pipelineCommands.push({ cmd: 'expire', args: [key, ttl] });
    },
    async exec() {
      return pipelineExec();
    },
  };
}

const redisMock = {
  pipeline: vi.fn(() => makePipeline()),
  // lib/redis.ts attaches a rate-limited 'error' listener at module
  // scope; the mock must be faithful enough for that to work.
  on: vi.fn(),
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  }),
  del: vi.fn(async (key: string) => {
    store.delete(key);
    return 1;
  }),
  mget: mgetImpl,
  scan: scanImpl,
};

vi.mock('ioredis', () => ({
  default: vi.fn(() => redisMock),
  Redis: vi.fn(() => redisMock),
}));

beforeEach(() => {
  vi.resetModules();
  pipelineCommands.length = 0;
  pipelineExec = async () => [];
  store.clear();
  redisMock.get.mockReset();
  redisMock.get.mockImplementation(async (key: string) => store.get(key) ?? null);
  redisMock.set.mockClear();
  redisMock.del.mockClear();
  redisMock.pipeline.mockClear();
  mgetImpl.mockReset();
  mgetImpl.mockImplementation(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null));
  scanImpl.mockReset();
  scanImpl.mockResolvedValue(['0', []] as [string, string[]]);
  vi.stubEnv('NODE_ENV', 'test');
});

const SERVER_ID = 'srv-1';
const FIXED_NOW = new Date('2026-03-15T14:30:00.000Z'); // 2026-03-15, 14:30 UTC

describe('incrServerBandwidth', () => {
  it('skips non-positive or non-finite deltas', async () => {
    const { incrServerBandwidth } = await import('../redis.js');
    await incrServerBandwidth(SERVER_ID, 0, { now: FIXED_NOW });
    await incrServerBandwidth(SERVER_ID, -10, { now: FIXED_NOW });
    await incrServerBandwidth(SERVER_ID, Number.NaN, { now: FIXED_NOW });
    expect(pipelineCommands).toHaveLength(0);
  });

  it('writes total + day + hour counters with the expected key shapes and TTLs', async () => {
    const { incrServerBandwidth } = await import('../redis.js');
    await incrServerBandwidth(SERVER_ID, 1234.5, { now: FIXED_NOW });
    const cmds = pipelineCommands.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(cmds).toEqual([
      `incrbyfloat lf:test:bw:${SERVER_ID}:total 1234.5`,
      `incrbyfloat lf:test:bw:${SERVER_ID}:2026-03-15 1234.5`,
      `expire lf:test:bw:${SERVER_ID}:2026-03-15 3024000`,
      `incrbyfloat lf:test:bw:${SERVER_ID}:2026-03-15T14 1234.5`,
      `expire lf:test:bw:${SERVER_ID}:2026-03-15T14 691200`,
    ]);
  });

  it('sets the alert key when the threshold is crossed', async () => {
    store.set(`lf:test:bw:${SERVER_ID}:total`, '1000');
    const { incrServerBandwidth } = await import('../redis.js');
    await incrServerBandwidth(SERVER_ID, 100, { now: FIXED_NOW, alertThresholdBytes: 1000 });
    expect(store.get(`lf:test:bw:alert:${SERVER_ID}`)).toBe('1');
  });

  it('does not set the alert when below the threshold', async () => {
    store.set(`lf:test:bw:${SERVER_ID}:total`, '500');
    const { incrServerBandwidth } = await import('../redis.js');
    await incrServerBandwidth(SERVER_ID, 100, { now: FIXED_NOW, alertThresholdBytes: 1000 });
    expect(store.get(`lf:test:bw:alert:${SERVER_ID}`)).toBeUndefined();
  });

  it('omits the threshold check when no alertThresholdBytes is given', async () => {
    const { incrServerBandwidth } = await import('../redis.js');
    await incrServerBandwidth(SERVER_ID, 100, { now: FIXED_NOW });
    expect(redisMock.get).not.toHaveBeenCalled();
  });
});

describe('getServerBandwidthTotals', () => {
  it('clamps hours to [1,168]', async () => {
    mgetImpl.mockResolvedValue([]);
    const { getServerBandwidthTotals } = await import('../redis.js');
    const huge = await getServerBandwidthTotals(SERVER_ID, { hours: 9999, now: FIXED_NOW });
    expect(huge.hourly).toHaveLength(168);
    const zero = await getServerBandwidthTotals(SERVER_ID, { hours: 0, now: FIXED_NOW });
    expect(zero.hourly).toHaveLength(1);
  });

  it('parses total/today/hourly/alert values from mget', async () => {
    store.set(`lf:test:bw:${SERVER_ID}:total`, '5000');
    store.set(`lf:test:bw:${SERVER_ID}:2026-03-15`, '2500');
    store.set(`lf:test:bw:alert:${SERVER_ID}`, '1');
    const { getServerBandwidthTotals } = await import('../redis.js');
    const snap = await getServerBandwidthTotals(SERVER_ID, { hours: 1, now: FIXED_NOW });
    expect(snap.totalBytes).toBe(5000);
    expect(snap.todayBytes).toBe(2500);
    expect(snap.alertTriggered).toBe(true);
    expect(snap.hourly).toHaveLength(1);
    expect(snap.hourly[0]).toEqual({ hour: '2026-03-15T14', bytes: 0 });
  });

  it('reports zeros for a fresh server with no keys', async () => {
    const { getServerBandwidthTotals } = await import('../redis.js');
    const snap = await getServerBandwidthTotals(SERVER_ID, { hours: 3, now: FIXED_NOW });
    expect(snap.totalBytes).toBe(0);
    expect(snap.todayBytes).toBe(0);
    expect(snap.alertTriggered).toBe(false);
    expect(snap.hourly).toHaveLength(3);
    expect(snap.hourly.every((h) => h.bytes === 0)).toBe(true);
  });
});

describe('clearBandwidthAlert', () => {
  it('deletes the alert key', async () => {
    store.set(`lf:test:bw:alert:${SERVER_ID}`, '1');
    const { clearBandwidthAlert } = await import('../redis.js');
    await clearBandwidthAlert(SERVER_ID);
    expect(store.has(`lf:test:bw:alert:${SERVER_ID}`)).toBe(false);
  });
});

describe('setTyping / getTypingUsers', () => {
  it('writes a typing key with a 5s TTL and the display name', async () => {
    const { setTyping } = await import('../redis.js');
    await setTyping(SERVER_ID, 'ch-1', 'user-1', 'Alice');
    const expectedKey = `lf:test:typing:${SERVER_ID}:ch-1:user-1`;
    expect(store.get(expectedKey)).toBe('Alice');
    expect(redisMock.set).toHaveBeenCalledWith(expectedKey, 'Alice', 'EX', 5);
  });

  it('returns display names of currently-typing users', async () => {
    store.set(`lf:test:typing:${SERVER_ID}:ch-1:user-1`, 'Alice');
    store.set(`lf:test:typing:${SERVER_ID}:ch-1:user-2`, 'Bob');
    scanImpl.mockResolvedValue([
      '0',
      [
        `lf:test:typing:${SERVER_ID}:ch-1:user-1`,
        `lf:test:typing:${SERVER_ID}:ch-1:user-2`,
      ],
    ] as [string, string[]]);
    const { getTypingUsers } = await import('../redis.js');
    const typers = await getTypingUsers(SERVER_ID, 'ch-1');
    expect(typers.sort()).toEqual(['Alice', 'Bob']);
  });

  it('excludes the caller from the result', async () => {
    store.set(`lf:test:typing:${SERVER_ID}:ch-1:user-1`, 'Alice');
    store.set(`lf:test:typing:${SERVER_ID}:ch-1:user-2`, 'Bob');
    scanImpl.mockResolvedValue([
      '0',
      [
        `lf:test:typing:${SERVER_ID}:ch-1:user-1`,
        `lf:test:typing:${SERVER_ID}:ch-1:user-2`,
      ],
    ] as [string, string[]]);
    const { getTypingUsers } = await import('../redis.js');
    const typers = await getTypingUsers(SERVER_ID, 'ch-1', 'user-1');
    expect(typers).toEqual(['Bob']);
  });

  it('returns an empty array when nobody is typing', async () => {
    scanImpl.mockResolvedValue(['0', []] as [string, string[]]);
    const { getTypingUsers } = await import('../redis.js');
    const typers = await getTypingUsers(SERVER_ID, 'ch-1');
    expect(typers).toEqual([]);
  });
});
