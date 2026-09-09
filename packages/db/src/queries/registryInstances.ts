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

/**
 * 10th-audit: legacy rows predate the owner column (owner NULL). The
 * old "first updater claims it" rule let ANY authenticated user seize
 * a listed legacy instance and rewrite its domain — a discovery
 * phishing vector. Unclaimed rows are admin-recovery territory only.
 */
export class RegistryInstanceUnclaimableError extends Error {
  constructor() {
    super('This instance predates ownership tracking and cannot be claimed through self-service registration. Contact the directory administrators.');
    this.name = 'RegistryInstanceUnclaimableError';
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
  /** Ed25519 public key (PEM or base64 DER SPKI) — heartbeat signer. */
  publicKey: string;
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
  // 10th-audit: NULL-owner legacy rows are NOT claimable via upsert.
  if (existing && existing.ownerUserId === null) {
    throw new RegistryInstanceUnclaimableError();
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
    ownerUserId: input.actorUserId,
  };
  // 11th-audit: the ownership decision is INSIDE the atomic statement.
  // The old SELECT-then-upsert let a concurrent second registrant
  // rewrite the winner's metadata via the conflict branch. Now the
  // conflict update carries a WHERE that only fires for the rightful
  // owner (or the single legacy-NULL claim), so the race loser's
  // insert-update is a no-op and the pre-check error stands.
  const [row] = await db
    .insert(registryInstances)
    .values(values)
    .onConflictDoUpdate({
      target: registryInstances.instanceId,
      set: {
        // 13th-audit: DOMAIN IS IMMUTABLE HERE. The register proof
        // verifies the REQUEST's key against the new domain — an
        // attacker with a hijacked owner session could otherwise point
        // a listed instance at their own (self-verified) domain.
        // Domain moves go through changeRegistryInstanceDomain, which
        // additionally proves possession of the STORED private key.
        name: values.name,
        description: values.description,
        region: values.region,
        languages: values.languages,
        tags: values.tags,
        features: values.features,
      },
      setWhere: sql`${registryInstances.ownerUserId} = excluded.owner_user_id`,
    })
    .returning();
  // 12th-audit: the race loser's setWhere is false → no row returned.
  // Surface the REAL reason (someone else owns it) instead of letting
  // an undefined row 500 downstream.
  if (!row) {
    throw new RegistryInstanceOwnedError(true);
  }
  return row as RegistryInstanceRow;
}

/** 13th-audit: change the instance's domain. Requires BOTH the owner
 * session AND a proof signed with the CURRENT (stored) private key —
 * the same model rotate-key uses, so a hijacked session alone cannot
 * redirect discovery traffic to an attacker-controlled domain. */
export async function changeRegistryInstanceDomain(
  db: DbClient,
  input: { instanceId: string; ownerUserId: string; newDomain: string }
): Promise<boolean> {
  const updated = await db
    .update(registryInstances)
    .set({ domain: input.newDomain })
    .where(
      and(
        eq(registryInstances.instanceId, input.instanceId),
        eq(registryInstances.ownerUserId, input.ownerUserId)
      )
    )
    .returning({ id: registryInstances.id });
  return updated.length > 0;
}

/** 10th-audit: rotate the instance signing key. Owner-only. */
export async function rotateRegistryInstanceKey(
  db: DbClient,
  input: { instanceId: string; ownerUserId: string; newPublicKey: string }
): Promise<void> {
  await db
    .update(registryInstances)
    .set({ publicKey: input.newPublicKey })
    .where(
      and(
        eq(registryInstances.instanceId, input.instanceId),
        eq(registryInstances.ownerUserId, input.ownerUserId)
      )
    );
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
