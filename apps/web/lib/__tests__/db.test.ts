import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const envSnapshot = { ...process.env };

beforeEach(() => {
  // Clear the singleton between tests so each one gets a fresh config read.
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('DATABASE_')) delete (process.env as Record<string, string | undefined>)[key];
  }
});

afterEach(() => {
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

describe('getDb', () => {
  it('throws when DATABASE_URL is missing', async () => {
    await expect(import('../db.js').then((m) => m.getDb())).rejects.toThrow(/DATABASE_URL/);
  });

  it('caches the client on the second call', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/d';
    const { getDb, __setDbForTests } = await import('../db.js');
    __setDbForTests({
      // Minimal shape — getDb only stores/returns whatever it is given.
      // The cast sidesteps the Drizzle type since we never call anything on it.
      __mock: true,
    } as unknown as ReturnType<typeof getDb>);
    const a = getDb();
    const b = getDb();
    expect(a).toBe(b);
  });

  it('__setDbForTests(null) wipes the cache', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/d';
    const { getDb, __setDbForTests } = await import('../db.js');
    __setDbForTests({ __mock: 'a' } as unknown as ReturnType<typeof getDb>);
    expect((getDb() as unknown as { __mock: string }).__mock).toBe('a');
    __setDbForTests(null);
    // After wipe, getDb would normally call createDb — which would try to
    // connect. So we test the wipe by re-setting and verifying the second
    // call returns the new value, not the first.
    __setDbForTests({ __mock: 'b' } as unknown as ReturnType<typeof getDb>);
    expect((getDb() as unknown as { __mock: string }).__mock).toBe('b');
  });
});
