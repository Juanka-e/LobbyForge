/**
 * DB accessor for the WS gateway.
 *
 * The Next.js app uses `@/lib/db` which is a Next-only path alias.
 * The gateway runs as a plain Node process, so it builds its own
 * connection via `@lobbyforge/db`'s `createDatabase` (when exported)
 * or, in the M20-bis MVP, via the same `postgres` driver the web app
 * uses. Tests pass in a mock DB instead.
 */
import { createDb } from '@lobbyforge/db';

let cachedDb: unknown | null = null;

export function getDb(): unknown {
  if (cachedDb) return cachedDb;
  // Lazy import — the production wiring is provided by an env var
  // (`LF_DB_URL`). Tests inject their own DB via `__setDb(...)`.
  const url = process.env.LF_DB_URL;
  if (!url) {
    throw new Error(
      'LF_DB_URL is not set. The ws-gateway cannot resolve the DB. ' +
        'For local dev, set LF_DB_URL=postgres://... matching the web app.'
    );
  }
  // The web app uses `postgres` directly; we mirror the minimal surface
  // here so the queries the gateway needs (isServerMember, getServerById)
  // can run without dragging the entire web tsconfig into the gateway.
  // For M20-bis MVP, callers can also pass a pre-built DB via __setDb.
  cachedDb = createDefaultDb(url);
  return cachedDb;
}

function createDefaultDb(url: string): unknown {
  return createDb(url);
}

/**
 * Test-only: inject a mock DB so unit tests don't need Postgres.
 */
export function __setDb(db: unknown): void {
  cachedDb = db;
}

export function __resetDb(): void {
  cachedDb = null;
}
