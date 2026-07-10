/**
 * Audit log queries — thin wrappers over the Drizzle client.
 *
 * The `audit_logs` table is the moderation log. Every mutating route
 * (channel create / update / delete, message delete, role create /
 * update / delete, member kick / role-assign, invite create / revoke /
 * redeem, ban create / remove) should land a row here so admins can
 * audit "who did what when" without trawling the per-resource tables.
 *
 * The shape is intentionally simple: a server (optional for global
 * actions), an actor (the user who did the thing), an action string,
 * a target type + id, and a metadata JSONB blob for action-specific
 * data. Routes call `logAction` from inside their handler — it's
 * fire-and-forget from the caller's perspective.
 */
import { and, desc, eq, lt } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { auditLogs } from '../schema.js';

export interface AuditLogRow {
  id: string;
  serverId: string | null;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface LogActionInput {
  serverId?: string | null;
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append a row to the audit log. The route layer calls this after a
 * successful mutation; failures here are non-fatal (logged via
 * console.error in the caller) so a transient audit-log write doesn't
 * fail the user-facing mutation.
 */
export async function logAction(db: DbClient, input: LogActionInput): Promise<void> {
  await db.insert(auditLogs).values({
    serverId: input.serverId ?? null,
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    metadata: input.metadata ?? {},
  });
}

/**
 * Read the audit log for a server, newest first. Bounded to 100 to keep
 * the read cheap; the UI paginates with a `before` cursor.
 */
export async function listAuditLogsForServer(
  db: DbClient,
  serverId: string,
  options: { before?: Date; limit?: number } = {}
): Promise<AuditLogRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const where = options.before
    ? and(eq(auditLogs.serverId, serverId), lt(auditLogs.createdAt, options.before))
    : eq(auditLogs.serverId, serverId);
  const rows = await db
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
  return rows as AuditLogRow[];
}
