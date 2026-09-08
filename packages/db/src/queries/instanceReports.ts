/**
 * Instance-report queries (discovery directory complaints — Faz D).
 *
 * Reports are filed from the discovery cards (POST /api/directory/:id/
 * report) and triaged in the admin moderation panel: pending first,
 * then resolved ones for audit.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { instanceReports, users } from '../schema.js';

export type InstanceReportStatus = 'pending' | 'reviewed' | 'dismissed' | 'actioned';

export interface InstanceReportRow {
  id: string;
  instanceId: string;
  reporterUserId: string | null;
  reporterName: string | null;
  reason: string;
  detail: string | null;
  status: InstanceReportStatus;
  reviewerUserId: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

/** List reports for the moderation panel — newest first, pending first. */
export async function listInstanceReports(
  db: DbClient,
  options: { limit?: number; status?: InstanceReportStatus } = {}
): Promise<InstanceReportRow[]> {
  const limit = Math.min(options.limit ?? 100, 500);
  const rows = await db
    .select({
      id: instanceReports.id,
      instanceId: instanceReports.instanceId,
      reporterUserId: instanceReports.reporterUserId,
      reporterName: users.displayName,
      reason: instanceReports.reason,
      detail: instanceReports.detail,
      status: instanceReports.status,
      reviewerUserId: instanceReports.reviewerUserId,
      reviewedAt: instanceReports.reviewedAt,
      createdAt: instanceReports.createdAt,
    })
    .from(instanceReports)
    .leftJoin(users, eq(instanceReports.reporterUserId, users.id))
    .where(options.status ? eq(instanceReports.status, options.status) : undefined)
    .orderBy(
      // pending surfaces before resolved items, then newest first
      instanceReports.status,
      desc(instanceReports.createdAt),
    )
    .limit(limit);
  return rows as InstanceReportRow[];
}

/** Moderator decision on a report. */
export async function setInstanceReportStatus(
  db: DbClient,
  reportId: string,
  status: Exclude<InstanceReportStatus, 'pending'>,
  reviewerUserId: string | null
): Promise<boolean> {
  const updated = await db
    .update(instanceReports)
    .set({ status, reviewerUserId, reviewedAt: new Date() })
    .where(and(eq(instanceReports.id, reportId), eq(instanceReports.status, 'pending')))
    .returning({ id: instanceReports.id });
  return updated.length > 0;
}
