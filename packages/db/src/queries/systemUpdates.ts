import { desc, eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { systemUpdateEvents, systemUpdateRuns } from '../schema.js';

export type SystemUpdateAction = 'dry-run' | 'apply' | 'rollback';
export type SystemUpdateStatus = 'planned' | 'locked' | 'running' | 'succeeded' | 'failed' | 'rolled_back';

export interface SystemUpdateRunRow {
  id: string;
  action: SystemUpdateAction;
  status: SystemUpdateStatus;
  fromVersion: string;
  toVersion: string;
  channel: string;
  manifestKeyId: string | null;
  backupId: string | null;
  plan: Record<string, unknown>;
  gates: Record<string, unknown>;
  failures: string[];
  startedBy: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export type SystemUpdateEventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SystemUpdateEventRow {
  id: string;
  runId: string;
  stepId: string | null;
  level: SystemUpdateEventLevel;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateSystemUpdateRunInput {
  action: SystemUpdateAction;
  status: SystemUpdateStatus;
  fromVersion: string;
  toVersion: string;
  channel: string;
  manifestKeyId?: string | null;
  backupId?: string | null;
  plan?: Record<string, unknown>;
  gates?: Record<string, unknown>;
  failures?: string[];
  startedBy?: string | null;
}

export interface CreateSystemUpdateEventInput {
  runId: string;
  stepId?: string | null;
  level?: SystemUpdateEventLevel;
  message: string;
  metadata?: Record<string, unknown>;
}

export async function createSystemUpdateRun(
  db: DbClient,
  input: CreateSystemUpdateRunInput
): Promise<SystemUpdateRunRow> {
  const [row] = await db
    .insert(systemUpdateRuns)
    .values({
      action: input.action,
      status: input.status,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      channel: input.channel,
      manifestKeyId: input.manifestKeyId ?? null,
      backupId: input.backupId ?? null,
      plan: input.plan ?? {},
      gates: input.gates ?? {},
      failures: input.failures ?? [],
      startedBy: input.startedBy ?? null,
    })
    .returning();
  if (!row) throw new Error('createSystemUpdateRun: insert returned no rows');
  return row as SystemUpdateRunRow;
}

export async function createSystemUpdateEvent(
  db: DbClient,
  input: CreateSystemUpdateEventInput
): Promise<SystemUpdateEventRow> {
  const [row] = await db
    .insert(systemUpdateEvents)
    .values({
      runId: input.runId,
      stepId: input.stepId ?? null,
      level: input.level ?? 'info',
      message: input.message,
      metadata: input.metadata ?? {},
    })
    .returning();
  if (!row) throw new Error('createSystemUpdateEvent: insert returned no rows');
  return row as SystemUpdateEventRow;
}

export async function listSystemUpdateRuns(
  db: DbClient,
  options: { limit?: number } = {}
): Promise<SystemUpdateRunRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const rows = await db
    .select()
    .from(systemUpdateRuns)
    .orderBy(desc(systemUpdateRuns.startedAt))
    .limit(limit);
  return rows as SystemUpdateRunRow[];
}

export async function getSystemUpdateRunById(
  db: DbClient,
  id: string
): Promise<SystemUpdateRunRow | null> {
  const [row] = await db
    .select()
    .from(systemUpdateRuns)
    .where(eq(systemUpdateRuns.id, id))
    .limit(1);
  return (row as SystemUpdateRunRow | undefined) ?? null;
}

export async function listSystemUpdateEvents(
  db: DbClient,
  runId: string,
  options: { limit?: number } = {}
): Promise<SystemUpdateEventRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  const rows = await db
    .select()
    .from(systemUpdateEvents)
    .where(eq(systemUpdateEvents.runId, runId))
    .orderBy(desc(systemUpdateEvents.createdAt))
    .limit(limit);
  return rows as SystemUpdateEventRow[];
}

export async function markSystemUpdateRunRunning(
  db: DbClient,
  id: string
): Promise<SystemUpdateRunRow | null> {
  const [row] = await db
    .update(systemUpdateRuns)
    .set({
      status: 'running',
      failures: [],
      finishedAt: null,
    })
    .where(eq(systemUpdateRuns.id, id))
    .returning();
  return (row as SystemUpdateRunRow | undefined) ?? null;
}

export async function finishSystemUpdateRun(
  db: DbClient,
  id: string,
  status: Extract<SystemUpdateStatus, 'succeeded' | 'failed' | 'rolled_back'>,
  failures: string[] = []
): Promise<SystemUpdateRunRow | null> {
  const [row] = await db
    .update(systemUpdateRuns)
    .set({
      status,
      failures,
      finishedAt: new Date(),
    })
    .where(eq(systemUpdateRuns.id, id))
    .returning();
  return (row as SystemUpdateRunRow | undefined) ?? null;
}
