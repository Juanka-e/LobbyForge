/**
 * Production-grade migration runner.
 *
 * Replaces `db:push` (which is fine for prototyping) with a one-shot
 * `drizzle-kit migrate` invocation that walks the `drizzle/` directory
 * and applies every un-applied journal entry inside a transaction.
 *
 * Usage:
 *   pnpm -F @lobbyforge/db db:migrate
 *   DATABASE_URL=postgres://... pnpm -F @lobbyforge/db db:migrate
 *
 * The script reads DATABASE_URL from the env and falls back to the
 * dev DSN in `drizzle.config.ts` for parity with `db:push`.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url =
  process.env.DATABASE_URL ||
  'postgresql://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge';

async function main() {
  // `max: 1` because drizzle-orm's migrator holds a long-lived transaction;
  // a pool >1 throws on connection reuse inside the migration.
  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);
  try {
    await migrate(db, { migrationsFolder: './drizzle' });
    console.info('[db:migrate] migrations applied');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('[db:migrate] failed:', (err as Error).message);
  process.exit(1);
});
