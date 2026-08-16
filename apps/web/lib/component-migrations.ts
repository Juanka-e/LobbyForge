/**
 * Trusted, host-executed component data migrations.
 *
 * History: this module used runtime-only `webpackIgnore` imports so it
 * could also load from Next's edge-compiled instrumentation boundary.
 * That broke in production containers twice — raw Node ESM cannot
 * resolve the extensionless relative imports inside plugin TS sources,
 * nor the `@/lib` path alias — so the lazy built-in pack seeding 500'd
 * on every fresh instance (only webpack dev-mode resolution masked it).
 * Instrumentation no longer imports this module; every importer is a
 * Node-runtime route, so plain bundled imports are correct and robust.
 */
import {
  runComponentDataMigrations,
  seedBuiltInPacks,
  type ComponentMigrationPlan,
  type DbClient,
} from '@lobbyforge/db';
import { HUSHLE_BUILTIN_PACKS, HUSHLE_PLUGIN_ID } from '@lobbyforge/hushle';
import { getDb } from '@/lib/db';

let pending: Promise<void> | null = null;

export function ensureBuiltInContentSeeded(_db: DbClient): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    const plans: readonly ComponentMigrationPlan[] = [
      {
        componentType: 'game',
        componentId: 'hushle',
        migrations: [
          {
            version: 1,
            checksum: 'sha256:df8c3da58de38978aeffebecac605ec9a8e620a8f93a7c81ebe5dcf1820e12d8',
            run: async (db) => {
              await seedBuiltInPacks(db, HUSHLE_PLUGIN_ID, HUSHLE_BUILTIN_PACKS);
            },
          },
          {
            version: 2,
            checksum: 'sha256:f249ada9ad45dbaad5410232e7b4f26c586c59400dac5528dedc88d63be23d03',
            run: async (db) => {
              await seedBuiltInPacks(db, HUSHLE_PLUGIN_ID, HUSHLE_BUILTIN_PACKS);
            },
          },
        ],
      },
    ];

    const db = getDb();
    for (const plan of plans) {
      await runComponentDataMigrations(db, plan);
    }
  })().catch((error) => {
    pending = null;
    throw error;
  });
  return pending;
}
