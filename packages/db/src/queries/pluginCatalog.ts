/**
 * Plugin catalog queries — the marketplace listing + review pipeline.
 *
 * Community-submitted plugins land here with reviewStatus='pending'. An
 * admin reviews (approve/reject/delist). Approved entries are surfaced via
 * listPluginSummaries() so the existing per-server install flow works
 * unchanged.
 */
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { pluginCatalog } from '../schema.js';

export type PluginReviewStatus = 'pending' | 'approved' | 'rejected' | 'delisted';

export interface PluginCatalogRow {
  id: string;
  pluginId: string;
  name: string;
  version: string;
  type: string;
  summary: string | null;
  description: string | null;
  publisher: string;
  publisherUserId: string | null;
  trustLevel: string;
  category: string | null;
  tags: string[];
  permissions: string[];
  playerConfig: Record<string, unknown> | null;
  manifestUrl: string | null;
  iconUrl: string | null;
  reviewStatus: PluginReviewStatus;
  reviewerUserId: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  requiresVoiceRoom: boolean;
  downloadCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubmitPluginInput {
  pluginId: string;
  name: string;
  version: string;
  type: string;
  summary?: string | null;
  description?: string | null;
  publisher: string;
  trustLevel?: string;
  category?: string | null;
  tags?: string[];
  permissions?: string[];
  playerConfig?: Record<string, unknown> | null;
  manifestUrl?: string | null;
  iconUrl?: string | null;
  requiresVoiceRoom?: boolean;
}

/** List approved plugins for the marketplace browse page. */
export async function listApprovedPlugins(
  db: DbClient,
  options: {
    category?: string | null;
    search?: string | null;
    limit?: number;
  } = {}
): Promise<PluginCatalogRow[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const conditions = [eq(pluginCatalog.reviewStatus, 'approved')];
  if (options.category) {
    conditions.push(eq(pluginCatalog.category, options.category));
  }
  if (options.search) {
    conditions.push(ilike(pluginCatalog.name, `%${options.search}%`));
  }
  const rows = await db
    .select()
    .from(pluginCatalog)
    .where(and(...conditions))
    .orderBy(desc(pluginCatalog.downloadCount))
    .limit(limit);
  return rows as PluginCatalogRow[];
}

/** Get a single catalog entry by pluginId. */
export async function getCatalogEntry(
  db: DbClient,
  pluginId: string
): Promise<PluginCatalogRow | null> {
  const [row] = await db
    .select()
    .from(pluginCatalog)
    .where(eq(pluginCatalog.pluginId, pluginId))
    .limit(1);
  return (row as PluginCatalogRow) ?? null;
}

/** Thrown when a different publisher tries to take over a plugin ID. */
export class PluginIdTakenError extends Error {
  constructor(pluginId: string) {
    super(`Plugin ID "${pluginId}" is already published by another publisher.`);
    this.name = 'PluginIdTakenError';
  }
}

/**
 * Submit a plugin for review (or update an existing submission).
 *
 * SEC-006: the pluginId is an IDENTITY, not a slot — the FIRST publisher
 * owns it. A submit from a different user is a takeover attempt (point
 * the bundle URL of an approved plugin at their own code) and throws
 * PluginIdTakenError. A legitimate new version from the OWNER resets
 * reviewStatus to pending (changed code must be re-reviewed).
 */
export async function submitPluginForReview(
  db: DbClient,
  input: SubmitPluginInput,
  publisherUserId?: string
): Promise<PluginCatalogRow> {
  // SEC-006 ownership check BEFORE the upsert.
  const existing = await db
    .select({ publisherUserId: pluginCatalog.publisherUserId })
    .from(pluginCatalog)
    .where(eq(pluginCatalog.pluginId, input.pluginId))
    .limit(1);
  const currentOwner = existing[0]?.publisherUserId ?? null;
  if (currentOwner && publisherUserId && currentOwner !== publisherUserId) {
    throw new PluginIdTakenError(input.pluginId);
  }
  const values = {
    pluginId: input.pluginId,
    name: input.name,
    version: input.version,
    type: input.type,
    summary: input.summary ?? null,
    description: input.description ?? null,
    publisher: input.publisher,
    publisherUserId: publisherUserId ?? null,
    trustLevel: input.trustLevel ?? 'unverified',
    category: input.category ?? null,
    tags: input.tags ?? [],
    permissions: input.permissions ?? [],
    playerConfig: input.playerConfig ?? null,
    manifestUrl: input.manifestUrl ?? null,
    iconUrl: input.iconUrl ?? null,
    requiresVoiceRoom: input.requiresVoiceRoom ?? false,
  };
  const [row] = await db
    .insert(pluginCatalog)
    .values(values)
    .onConflictDoUpdate({
      target: pluginCatalog.pluginId,
      set: {
        // SEC-006: changed code needs re-review.
        reviewStatus: 'pending',
        name: values.name,
        version: values.version,
        summary: values.summary,
        description: values.description,
        category: values.category,
        tags: values.tags,
        permissions: values.permissions,
        playerConfig: values.playerConfig,
        manifestUrl: values.manifestUrl,
        iconUrl: values.iconUrl,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row as PluginCatalogRow;
}

/** Admin review: approve, reject, or delist a plugin. */
export async function reviewPlugin(
  db: DbClient,
  pluginId: string,
  decision: PluginReviewStatus,
  reviewerUserId: string,
  note?: string | null
): Promise<void> {
  await db
    .update(pluginCatalog)
    .set({
      reviewStatus: decision,
      reviewerUserId,
      reviewedAt: new Date(),
      reviewNote: note ?? null,
      updatedAt: new Date(),
      // Promote to verified-community on approval (unless already official).
      trustLevel: decision === 'approved' ? 'verified-community' : undefined,
    })
    .where(eq(pluginCatalog.pluginId, pluginId));
}

/** Increment the download/install count. */
export async function incrementDownloadCount(
  db: DbClient,
  pluginId: string
): Promise<void> {
  await db
    .update(pluginCatalog)
    .set({ downloadCount: sql`${pluginCatalog.downloadCount} + 1` })
    .where(eq(pluginCatalog.pluginId, pluginId));
}

/** List pending submissions (admin review queue). */
export async function listPendingSubmissions(
  db: DbClient,
  options: { limit?: number } = {}
): Promise<PluginCatalogRow[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const rows = await db
    .select()
    .from(pluginCatalog)
    .where(eq(pluginCatalog.reviewStatus, 'pending'))
    .orderBy(desc(pluginCatalog.createdAt))
    .limit(limit);
  return rows as PluginCatalogRow[];
}
