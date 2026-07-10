import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { componentMigrations } from '../schema.js';

export type ComponentType = 'plugin' | 'game' | 'bot' | 'tool';

export interface ComponentDataMigration {
  version: number;
  checksum: `sha256:${string}`;
  run: (db: DbClient) => Promise<void>;
}

export interface ComponentMigrationPlan {
  componentType: ComponentType;
  componentId: string;
  migrations: readonly ComponentDataMigration[];
}

export interface ComponentMigrationResult {
  applied: number[];
  alreadyApplied: number[];
}

function validatePlan(plan: ComponentMigrationPlan): void {
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(plan.componentId)) {
    throw new Error(`Invalid component migration id: ${plan.componentId}`);
  }
  let expectedVersion = 1;
  for (const migration of plan.migrations) {
    if (migration.version !== expectedVersion) {
      throw new Error(
        `Component ${plan.componentId} migration versions must be contiguous from 1`
      );
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(migration.checksum)) {
      throw new Error(`Invalid checksum for ${plan.componentId} migration ${migration.version}`);
    }
    expectedVersion += 1;
  }
}

/**
 * Apply trusted component data migrations serially and exactly once.
 * Each step owns a transaction-level advisory lock, its data writes and its
 * ledger insert, so a failed process cannot leave a migration marked applied.
 */
export async function runComponentDataMigrations(
  db: DbClient,
  plan: ComponentMigrationPlan
): Promise<ComponentMigrationResult> {
  validatePlan(plan);
  const result: ComponentMigrationResult = { applied: [], alreadyApplied: [] };

  for (const migration of plan.migrations) {
    await db.transaction(async (tx) => {
      const lockKey = `lobbyforge:${plan.componentType}:${plan.componentId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);

      const [existing] = await tx
        .select({ checksum: componentMigrations.checksum })
        .from(componentMigrations)
        .where(and(
          eq(componentMigrations.componentType, plan.componentType),
          eq(componentMigrations.componentId, plan.componentId),
          eq(componentMigrations.version, migration.version)
        ))
        .orderBy(asc(componentMigrations.version))
        .limit(1);

      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(
            `Checksum mismatch for ${plan.componentId} migration ${migration.version}`
          );
        }
        result.alreadyApplied.push(migration.version);
        return;
      }

      await migration.run(tx as unknown as DbClient);
      await tx.insert(componentMigrations).values({
        componentType: plan.componentType,
        componentId: plan.componentId,
        version: migration.version,
        checksum: migration.checksum,
      });
      result.applied.push(migration.version);
    });
  }

  return result;
}
