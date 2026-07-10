/**
 * Trusted, host-executed component data migrations.
 *
 * Top-level imports are TYPE-ONLY (`import type`), so the TypeScript
 * compiler erases them — webpack never tries to follow these import
 * chains at build time. The runtime `@lobbyforge/db` and
 * `@lobbyforge/hushle/builtInPacks` modules use `node:crypto` /
 * `node:net` internally; webpack's edge resolver cannot follow those
 * schemes and `serverExternalPackages` does not help for dynamic
 * imports (see apps/web/next.config.mjs). Loading them through a
 * dynamic `import()` with `webpackIgnore: true` leaves the call as a
 * plain Node runtime `import()` which understands `node:*` natively.
 *
 * In dev (`NODE_ENV !== 'production'`) the schema isn't available,
 * and the official migrations are no-ops anyway; the caller
 * (apps/web/instrumentation.ts) already short-circuits before this
 * function runs.
 */
import type { ComponentMigrationPlan } from '@lobbyforge/db';

let pending: Promise<void> | null = null;

export function runOfficialComponentMigrations(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    const { runComponentDataMigrations } = await import(
      /* webpackIgnore: true */ '@lobbyforge/db'
    );
    const { seedBuiltinHushlePacks } = await import(
      /* webpackIgnore: true */ '@lobbyforge/hushle/builtInPacks'
    );

    const plans: readonly ComponentMigrationPlan[] = [
      {
        componentType: 'game',
        componentId: 'hushle',
        migrations: [
          {
            version: 1,
            checksum: 'sha256:df8c3da58de38978aeffebecac605ec9a8e620a8f93a7c81ebe5dcf1820e12d8',
            run: async (db) => {
              await seedBuiltinHushlePacks(db);
            },
          },
          {
            version: 2,
            checksum: 'sha256:f249ada9ad45dbaad5410232e7b4f26c586c59400dac5528dedc88d63be23d03',
            run: async (db) => {
              await seedBuiltinHushlePacks(db);
            },
          },
        ],
      },
    ];

    const db = await getDb();
    for (const plan of plans) {
      await runComponentDataMigrations(db, plan);
    }
  })().catch((error) => {
    pending = null;
    throw error;
  });
  return pending;
}

async function getDb() {
  const mod = await import(/* webpackIgnore: true */ '@/lib/db');
  return mod.getDb();
}
