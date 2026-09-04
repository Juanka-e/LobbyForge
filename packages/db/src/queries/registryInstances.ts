/**
 * Registry instance queries — the community-server discovery directory.
 *
 * The `registry_instances` table (schema.ts:312) is purpose-built for a
 * discovery page: each row is a registered self-hosted LobbyForge instance
 * with moderation flags (isListed, isBlocked, isVerified), live stats
 * (onlineUsers, doctorScore, lastHeartbeatAt), and catalog metadata
 * (region, languages, tags, features).
 *
 * This query layer is the data backbone for the official instance's Discovery
 * surface (Faz 2). The API + UI are not yet wired — these helpers prepare
 * the ground so the discovery page can ship without a schema change.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { registryInstances } from '../schema.js';

/** SEC-007: the instance entry belongs to another user — upsert refused. */
export class RegistryInstanceOwnedError extends Error {
  constructor(public readonly ownerMismatch: true) {
    super('This directory instance is owned by another user');
    this.name = 'RegistryInstanceOwnedError';
  }
}

export interface RegistryInstanceRow {
  id: string;
  instanceId: string;
  name: string;
  domain: string;
  description: string | null;
  region: string | null;
  languages: string[];
  tags: string[];
  features: string[];
  isVerified: boolean;
  isListed: boolean;
  isBlocked: boolean;
  nsfw: boolean;
  onlineUsers: number;
  publicRoomsCount: number;
  version: string | null;
  doctorScore: number | null;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
  ownerUserId: string | null;
}

/** List public, listed, non-blocked instances for the discovery directory. */
export async function listPublicRegistryInstances(
  db: DbClient,
  options: { limit?: number; region?: string | null } = {}
): Promise<RegistryInstanceRow[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const conditions = [
    eq(registryInstances.isListed, true),
    eq(registryInstances.isBlocked, false),
  ];
  if (options.region) {
    conditions.push(eq(registryInstances.region, options.region));
  }
  const rows = await db
    .select()
    .from(registryInstances)
    .where(and(...conditions))
    .orderBy(desc(registryInstances.onlineUsers))
    .limit(limit);
  return rows as RegistryInstanceRow[];
}

/** Find a single registry instance by its instance id. */
export async function getRegistryInstanceByInstanceId(
  db: DbClient,
  instanceId: string
): Promise<RegistryInstanceRow | null> {
  const [row] = await db
    .select()
    .from(registryInstances)
    .where(eq(registryInstances.instanceId, instanceId))
    .limit(1);
  return (row as RegistryInstanceRow) ?? null;
}

export interface UpsertRegistryInstanceInput {
  instanceId: string;
  name: string;
  domain: string;
  description?: string | null;
  region?: string | null;
  languages?: string[];
  tags?: string[];
  features?: string[];
  publicKey: string;
  /** SEC-007: the acting user — must be the existing owner to update. */
  actorUserId: string;
}

/**
 * Register or update an instance in the directory (upsert on instanceId).
 *
 * Ownership (SEC-007): the FIRST registrant becomes the row's owner. An
 * upsert from any other user throws RegistryInstanceOwnedError instead of
 * overwriting a listed instance's name/domain (discovery-phishing guard).
 * Rows created before the owner column existed (owner NULL) are claimed by
 * the first updater — the legitimate operator registers before an attacker
 * in practice, and admins can still moderate via setRegistryInstanceListing.
 */
export async function upsertRegistryInstance(
  db: DbClient,
  input: UpsertRegistryInstanceInput
): Promise<RegistryInstanceRow> {
  const [existing] = await db
    .select({ ownerUserId: registryInstances.ownerUserId })
    .from(registryInstances)
    .where(eq(registryInstances.instanceId, input.instanceId))
    .limit(1);

  if (existing && existing.ownerUserId !== null && existing.ownerUserId !== input.actorUserId) {
    throw new RegistryInstanceOwnedError(true);
  }

  const values = {
    instanceId: input.instanceId,
    name: input.name,
    domain: input.domain,
    description: input.description ?? null,
    region: input.region ?? null,
    languages: input.languages ?? [],
    tags: input.tags ?? [],
    features: input.features ?? [],
    publicKey: input.publicKey,
    ownerUserId: existing ? existing.ownerUserId ?? input.actorUserId : input.actorUserId,
  };
  const [row] = await db
    .insert(registryInstances)
    .values(values)
    .onConflictDoUpdate({
      target: registryInstances.instanceId,
      set: {
        name: values.name,
        domain: values.domain,
        description: values.description,
        region: values.region,
        languages: values.languages,
        tags: values.tags,
        features: values.features,
        // Claim legacy NULL-owner rows exactly once; never steal a set owner.
        ownerUserId: sql`coalesce(${registryInstances.ownerUserId}, excluded.owner_user_id)`,
      },
    })
    .returning();
  return row as RegistryInstanceRow;
}

/** Ingest a heartbeat: bump live stats + lastHeartbeatAt. */
export async function heartbeatRegistryInstance(
  db: DbClient,
  instanceId: string,
  stats: { onlineUsers?: number; publicRoomsCount?: number; version?: string; doctorScore?: number }
): Promise<void> {
  await db
    .update(registryInstances)
    .set({
      ...(stats.onlineUsers != null ? { onlineUsers: stats.onlineUsers } : {}),
      ...(stats.publicRoomsCount != null ? { publicRoomsCount: stats.publicRoomsCount } : {}),
      ...(stats.version != null ? { version: stats.version } : {}),
      ...(stats.doctorScore != null ? { doctorScore: stats.doctorScore } : {}),
      lastHeartbeatAt: new Date(),
    })
    .where(eq(registryInstances.instanceId, instanceId));
}

/** Moderate: list/block/unblock an instance (admin-only, called from the
 *  official instance's moderation tools). */
export async function setRegistryInstanceListing(
  db: DbClient,
  instanceId: string,
  options: { isListed?: boolean; isBlocked?: boolean; isVerified?: boolean }
): Promise<void> {
  await db
    .update(registryInstances)
    .set({
      ...(options.isListed != null ? { isListed: options.isListed } : {}),
      ...(options.isBlocked != null ? { isBlocked: options.isBlocked } : {}),
      ...(options.isVerified != null ? { isVerified: options.isVerified } : {}),
    })
    .where(eq(registryInstances.instanceId, instanceId));
}
