/**
 * Singleton Postgres client for the web app.
 *
 * The Drizzle client wraps a `postgres` (postgres.js) connection. We hold
 * exactly one instance per Node process and reuse it across requests —
 * `postgres` already manages a pool under the hood, so this is just about
 * avoiding the cost of re-parsing the connection string.
 *
 * In dev, the hot-reload lifecycle is a concern: Next.js re-imports modules
 * between requests, so we stash the client on `globalThis` to survive the
 * re-import. The same trick is used by Prisma's recommended Next.js setup.
 */
import { createDb, parseDatabaseConfig, type DbClient } from '@lobbyforge/db';

const GLOBAL_KEY = '__lobbyforge_web_db__';

interface GlobalWithDb {
  [GLOBAL_KEY]?: DbClient;
}

function readConfig() {
  return parseDatabaseConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
    DATABASE_SSL: process.env.DATABASE_SSL,
  });
}

/**
 * Return the process-wide Drizzle client, creating it on first call.
 * Throws if `DATABASE_URL` is missing — fail loud at startup, not on the
 * first request that needs the DB.
 */
export function getDb(): DbClient {
  const g = globalThis as unknown as GlobalWithDb;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as DbClient;
  const config = readConfig();
  const client = createDb(config.url);
  g[GLOBAL_KEY] = client;
  return client;
}

/**
 * Test-only hook to swap the cached client (or wipe it). The route tests
 * call this with a mock to avoid hitting a real Postgres.
 */
export function __setDbForTests(client: DbClient | null): void {
  const g = globalThis as unknown as GlobalWithDb;
  if (client === null) {
    delete g[GLOBAL_KEY];
  } else {
    g[GLOBAL_KEY] = client;
  }
}
