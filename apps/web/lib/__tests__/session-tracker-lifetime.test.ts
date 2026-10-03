import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security follow-up (absolute session lifetime): a recorded session
 * remembers when it started, its Redis entry never outlives the absolute
 * lifetime, the active-sessions list hides over-age entries — and
 * revokeOtherSessions still revokes them (missing a live one is the only
 * dangerous mistake).
 */

const { store, sets } = vi.hoisted(() => ({
  store: new Map<string, { value: string; ttl: number }>(),
  sets: new Map<string, Set<string>>(),
}));

vi.mock('@/lib/redis', () => ({
  redis: {
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    set: vi.fn(async (key: string, value: string, _ex: string, ttl: number) => {
      store.set(key, { value, ttl });
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    mget: vi.fn(async (...keys: string[]) => keys.map((key) => store.get(key)?.value ?? null)),
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return ['0', [...store.keys()].filter((key) => key.startsWith(prefix))];
    }),
    sismember: vi.fn(async (key: string, member: string) => (sets.get(key)?.has(member) ? 1 : 0)),
    sadd: vi.fn(async (key: string, member: string) => {
      const set = sets.get(key) ?? new Set<string>();
      set.add(member);
      sets.set(key, set);
      return 1;
    }),
    expire: vi.fn(async () => 1),
  },
}));

import { listSessions, recordSession, revokeOtherSessions, type SessionFingerprint } from '../session-tracker.js';

const USER = '00000000-0000-4000-8000-000000000001';
const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;
const gid = (c: string) => `g_${c.repeat(32)}`;
const request = () => new Request('https://example.test/api/auth/guest');
const nowSeconds = () => Math.floor(Date.now() / 1000);

function entry(g: string): { fingerprint: SessionFingerprint; ttl: number } {
  const raw = store.get(`lf:${process.env.NODE_ENV || 'dev'}:session:${USER}:${g}`);
  if (!raw) throw new Error(`no entry for ${g}`);
  return { fingerprint: JSON.parse(raw.value) as SessionFingerprint, ttl: raw.ttl };
}

beforeEach(() => {
  store.clear();
  sets.clear();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('recordSession — absolute lifetime', () => {
  it('a new session starts now and keeps the usual 7-day inactivity TTL', async () => {
    const before = Date.now();
    await recordSession(USER, gid('a'), request());
    const { fingerprint, ttl } = entry(gid('a'));
    expect(fingerprint.sessionStartedAt).toBeGreaterThanOrEqual(before);
    expect(ttl).toBe(WEEK);
  });

  it('takes the start from the cookie auth_time and caps the TTL at the time left', async () => {
    const authTime = nowSeconds() - 29 * DAY - 22 * 3600; // two hours left of 30 days
    await recordSession(USER, gid('a'), request(), { authTime });
    const { fingerprint, ttl } = entry(gid('a'));
    expect(fingerprint.sessionStartedAt).toBe(authTime * 1000);
    expect(ttl).toBeGreaterThan(2 * 3600 - 5);
    expect(ttl).toBeLessThanOrEqual(2 * 3600);
  });

  it('keeps the recorded start when the caller does not know auth_time', async () => {
    const authTime = nowSeconds() - 3 * DAY;
    await recordSession(USER, gid('a'), request(), { authTime });
    await recordSession(USER, gid('a'), request());
    expect(entry(gid('a')).fingerprint.sessionStartedAt).toBe(authTime * 1000);
  });

  it('honours LOBBYFORGE_SESSION_MAX_AGE_DAYS', async () => {
    vi.stubEnv('LOBBYFORGE_SESSION_MAX_AGE_DAYS', '1');
    await recordSession(USER, gid('a'), request(), { authTime: nowSeconds() - 12 * 3600 });
    const { ttl } = entry(gid('a'));
    expect(ttl).toBeGreaterThan(12 * 3600 - 5);
    expect(ttl).toBeLessThanOrEqual(12 * 3600);
  });
});

describe('listSessions / revokeOtherSessions — absolute lifetime', () => {
  async function seed() {
    await recordSession(USER, gid('a'), request(), { authTime: nowSeconds() - DAY }); // live
    await recordSession(USER, gid('b'), request(), { authTime: nowSeconds() - 20 * DAY }); // live
    // Recorded under a longer limit, then the operator lowered it to 10 days.
    vi.stubEnv('LOBBYFORGE_SESSION_MAX_AGE_DAYS', '30');
    await recordSession(USER, gid('c'), request(), { authTime: nowSeconds() - 15 * DAY });
    vi.stubEnv('LOBBYFORGE_SESSION_MAX_AGE_DAYS', '10');
  }

  it('hides sessions past the absolute lifetime from the active-sessions list', async () => {
    await seed();
    const gids = (await listSessions(USER)).map((s) => s.gid).sort();
    expect(gids).toEqual([gid('a')]);
  });

  it('lists legacy entries without a start time', async () => {
    const legacy: SessionFingerprint = {
      gid: gid('d'), userId: USER, ipAddress: 'unknown', browser: 'Firefox', os: 'Linux',
      deviceType: 'Desktop', location: '', createdAt: Date.now() - 60 * DAY * 1000, lastSeen: Date.now(),
    };
    store.set(`lf:${process.env.NODE_ENV || 'dev'}:session:${USER}:${gid('d')}`, { value: JSON.stringify(legacy), ttl: WEEK });
    expect((await listSessions(USER)).map((s) => s.gid)).toEqual([gid('d')]);
  });

  it('revokeOtherSessions revokes over-age entries too', async () => {
    await seed();
    const revoked = await revokeOtherSessions(USER, gid('a'));
    expect(revoked).toBe(2);
    const set = sets.get(`lf:${process.env.NODE_ENV || 'dev'}:session-revoked:${USER}`);
    expect([...(set ?? [])].sort()).toEqual([gid('b'), gid('c')]);
  });
});
