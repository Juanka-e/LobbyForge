import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { instanceSettings, servers, users } from '../schema.js';
import { createServer, type ServerRow } from './servers.js';

export const DEFAULT_INSTANCE_ID = 'self-host';
const DEFAULT_INSTANCE_NAME = 'LobbyForge';

export type InstanceRegistrationMode = 'open' | 'invite_only' | 'closed';

export interface InstanceAccessSettings {
  instanceId: string;
  registrationMode: InstanceRegistrationMode;
  guestAccessEnabled: boolean;
  seoIndexingEnabled: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  updatedAt: Date | null;
}

export interface SetInstanceAccessSettingsInput {
  instanceId?: string;
  registrationMode: InstanceRegistrationMode;
  guestAccessEnabled: boolean;
  seoIndexingEnabled: boolean;
  seoTitle?: string | null;
  seoDescription?: string | null;
  now?: Date;
}

export interface InstanceMaintenanceStatus {
  instanceId: string;
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
  maintenanceStartedAt: Date | null;
  maintenanceUpdatedAt: Date | null;
}

export interface SetInstanceMaintenanceInput {
  instanceId?: string;
  enabled: boolean;
  message?: string | null;
  now?: Date;
}

function toAccessSettings(row: typeof instanceSettings.$inferSelect): InstanceAccessSettings {
  return {
    instanceId: row.instanceId,
    registrationMode: row.registrationMode as InstanceRegistrationMode,
    guestAccessEnabled: row.guestAccessEnabled,
    seoIndexingEnabled: row.seoIndexingEnabled,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    updatedAt: row.updatedAt,
  };
}

export async function getEffectiveInstanceAccessSettings(
  db: DbClient,
  instanceId = DEFAULT_INSTANCE_ID
): Promise<InstanceAccessSettings> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.instanceId, instanceId))
    .limit(1);
  if (row) return toAccessSettings(row);
  return {
    instanceId,
    registrationMode: 'invite_only',
    guestAccessEnabled: true,
    seoIndexingEnabled: false,
    seoTitle: null,
    seoDescription: null,
    updatedAt: null,
  };
}

export async function setInstanceAccessSettings(
  db: DbClient,
  input: SetInstanceAccessSettingsInput
): Promise<InstanceAccessSettings> {
  const instanceId = input.instanceId ?? DEFAULT_INSTANCE_ID;
  const now = input.now ?? new Date();
  const values = {
    registrationMode: input.registrationMode,
    guestAccessEnabled: input.guestAccessEnabled,
    seoIndexingEnabled: input.seoIndexingEnabled,
    seoTitle: input.seoTitle?.trim().slice(0, 70) || null,
    seoDescription: input.seoDescription?.trim().slice(0, 160) || null,
    updatedAt: now,
  };
  const [updated] = await db
    .update(instanceSettings)
    .set(values)
    .where(eq(instanceSettings.instanceId, instanceId))
    .returning();
  if (updated) return toAccessSettings(updated);

  const [inserted] = await db
    .insert(instanceSettings)
    .values({
      instanceId,
      instanceName: DEFAULT_INSTANCE_NAME,
      ...values,
    })
    .returning();
  if (!inserted) throw new Error('setInstanceAccessSettings: insert returned no rows');
  return toAccessSettings(inserted);
}

function toMaintenanceStatus(row: typeof instanceSettings.$inferSelect): InstanceMaintenanceStatus {
  return {
    instanceId: row.instanceId,
    maintenanceMode: row.maintenanceMode,
    maintenanceMessage: row.maintenanceMessage,
    maintenanceStartedAt: row.maintenanceStartedAt,
    maintenanceUpdatedAt: row.maintenanceUpdatedAt,
  };
}

export async function getEffectiveInstanceMaintenance(
  db: DbClient,
  instanceId = DEFAULT_INSTANCE_ID
): Promise<InstanceMaintenanceStatus> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.instanceId, instanceId))
    .limit(1);
  if (row) return toMaintenanceStatus(row);
  return {
    instanceId,
    maintenanceMode: false,
    maintenanceMessage: null,
    maintenanceStartedAt: null,
    maintenanceUpdatedAt: null,
  };
}

export async function setInstanceMaintenance(
  db: DbClient,
  input: SetInstanceMaintenanceInput
): Promise<InstanceMaintenanceStatus> {
  const instanceId = input.instanceId ?? DEFAULT_INSTANCE_ID;
  const now = input.now ?? new Date();
  const message = input.message?.trim() ? input.message.trim().slice(0, 280) : null;
  const existing = await getEffectiveInstanceMaintenance(db, instanceId);
  const maintenanceStartedAt = input.enabled
    ? existing.maintenanceStartedAt ?? now
    : null;

  const values = {
    maintenanceMode: input.enabled,
    maintenanceMessage: message,
    maintenanceStartedAt,
    maintenanceUpdatedAt: now,
    updatedAt: now,
  };
  const [updated] = await db
    .update(instanceSettings)
    .set(values)
    .where(eq(instanceSettings.instanceId, instanceId))
    .returning();
  if (updated) return toMaintenanceStatus(updated);

  const [inserted] = await db
    .insert(instanceSettings)
    .values({
      instanceId,
      instanceName: DEFAULT_INSTANCE_NAME,
      ...values,
    })
    .returning();
  if (!inserted) throw new Error('setInstanceMaintenance: insert returned no rows');
  return toMaintenanceStatus(inserted);
}

// ---- /setup wizard (M21) -------------------------------------------------

export interface InstanceSetupStatus {
  instanceId: string;
  instanceName: string;
  instanceLogoUrl: string | null;
  setupCompletedAt: Date | null;
  bootstrapVersion: number;
  ownerUserId: string | null;
}

export interface InstanceBootstrapStatus extends InstanceSetupStatus {
  ownerCredentialsConfigured: boolean;
  firstServerId: string | null;
  bootstrapComplete: boolean;
}

/**
 * Read the /setup lock state. `setupCompletedAt === null` means the
 * instance is in setup mode — the /setup page should render the wizard.
 * After /setup completes, the same page redirects to /lobby.
 *
 * Returns sensible defaults when no row exists yet so the wizard can
 * render the pre-insert state without a separate "first-run" code path.
 */
export async function getInstanceSetupStatus(
  db: DbClient,
  instanceId = DEFAULT_INSTANCE_ID
): Promise<InstanceSetupStatus> {
  const [row] = await db
    .select({
      instanceId: instanceSettings.instanceId,
      instanceName: instanceSettings.instanceName,
      instanceLogoUrl: instanceSettings.instanceLogoUrl,
      setupCompletedAt: instanceSettings.setupCompletedAt,
      bootstrapVersion: instanceSettings.bootstrapVersion,
      ownerUserId: instanceSettings.ownerUserId,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.instanceId, instanceId))
    .limit(1);
  if (row) return row;
  return {
    instanceId,
    instanceName: DEFAULT_INSTANCE_NAME,
    instanceLogoUrl: null,
    setupCompletedAt: null,
    bootstrapVersion: 1,
    ownerUserId: null,
  };
}

export async function getInstanceBootstrapStatus(
  db: DbClient,
  instanceId = DEFAULT_INSTANCE_ID
): Promise<InstanceBootstrapStatus> {
  const setup = await getInstanceSetupStatus(db, instanceId);
  if (!setup.ownerUserId) {
    return {
      ...setup,
      ownerCredentialsConfigured: false,
      firstServerId: null,
      bootstrapComplete: Boolean(setup.setupCompletedAt && setup.bootstrapVersion >= 2),
    };
  }
  const [owner] = await db
    .select({ email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, setup.ownerUserId))
    .limit(1);
  const [server] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.ownerUserId, setup.ownerUserId))
    .limit(1);
  const ownerCredentialsConfigured = Boolean(owner?.email && owner.passwordHash);
  const firstServerId = server?.id ?? null;
  return {
    ...setup,
    ownerCredentialsConfigured,
    firstServerId,
    bootstrapComplete: Boolean(setup.setupCompletedAt && setup.bootstrapVersion >= 2),
  };
}

export interface CompleteInstanceSetupInput {
  instanceId?: string;
  instanceName: string;
  ownerUserId: string;
  registrationMode: InstanceRegistrationMode;
  guestAccessEnabled: boolean;
  seoIndexingEnabled: boolean;
  seoTitle?: string | null;
  seoDescription?: string | null;
  now?: Date;
}

/**
 * Persist the wizard's final state in a single call. Upserts the
 * instance row (insert if missing) and stamps `setupCompletedAt`.
 *
 * The wizard's caller is responsible for creating the owner user row
 * first (see `getOrCreateOwnerUser`) and for refusing to run when
 * `setupCompletedAt` is already set — this function does not re-check
 * for race safety. The /api/setup/complete endpoint re-checks under a
 * serializable transaction.
 */
export async function completeInstanceSetup(
  db: DbClient,
  input: CompleteInstanceSetupInput
): Promise<InstanceSetupStatus> {
  const instanceId = input.instanceId ?? DEFAULT_INSTANCE_ID;
  const now = input.now ?? new Date();
  const seoTitle = input.seoTitle?.trim().slice(0, 70) || null;
  const seoDescription = input.seoDescription?.trim().slice(0, 160) || null;

  const [updated] = await db
    .update(instanceSettings)
    .set({
      instanceName: input.instanceName.trim().slice(0, 80) || DEFAULT_INSTANCE_NAME,
      ownerUserId: input.ownerUserId,
      registrationMode: input.registrationMode,
      guestAccessEnabled: input.guestAccessEnabled,
      seoIndexingEnabled: input.seoIndexingEnabled,
      seoTitle,
      seoDescription,
      setupCompletedAt: now,
      bootstrapVersion: 2,
      updatedAt: now,
    })
    .where(eq(instanceSettings.instanceId, instanceId))
    .returning({
      instanceId: instanceSettings.instanceId,
      instanceName: instanceSettings.instanceName,
      instanceLogoUrl: instanceSettings.instanceLogoUrl,
      setupCompletedAt: instanceSettings.setupCompletedAt,
      bootstrapVersion: instanceSettings.bootstrapVersion,
      ownerUserId: instanceSettings.ownerUserId,
    });
  if (updated) return updated;

  const [inserted] = await db
    .insert(instanceSettings)
    .values({
      instanceId,
      instanceName: input.instanceName.trim().slice(0, 80) || DEFAULT_INSTANCE_NAME,
      ownerUserId: input.ownerUserId,
      registrationMode: input.registrationMode,
      guestAccessEnabled: input.guestAccessEnabled,
      seoIndexingEnabled: input.seoIndexingEnabled,
      seoTitle,
      seoDescription,
      setupCompletedAt: now,
      bootstrapVersion: 2,
    })
    .returning({
      instanceId: instanceSettings.instanceId,
      instanceName: instanceSettings.instanceName,
      instanceLogoUrl: instanceSettings.instanceLogoUrl,
      setupCompletedAt: instanceSettings.setupCompletedAt,
      bootstrapVersion: instanceSettings.bootstrapVersion,
      ownerUserId: instanceSettings.ownerUserId,
    });
  if (!inserted) throw new Error('completeInstanceSetup: insert returned no rows');
  return inserted;
}

export interface CreateOwnerUserInput {
  displayName: string;
  locale?: string;
}

export interface CompleteInitialBootstrapInput extends Omit<CompleteInstanceSetupInput, 'ownerUserId'> {
  ownerDisplayName: string;
  ownerEmail: string;
  ownerPasswordHash: string;
}

export interface CompleteInitialBootstrapResult {
  setup: InstanceSetupStatus;
  owner: { id: string; displayName: string; email: string };
  server: ServerRow;
}

export class SetupAlreadyCompleteError extends Error {
  constructor() {
    super('Setup is already complete.');
    this.name = 'SetupAlreadyCompleteError';
  }
}

/**
 * Finish first-run bootstrap atomically. Besides fresh installs, this repairs
 * the legacy M21 state where setup was marked complete after creating an
 * owner without credentials or a first server.
 */
export async function completeInitialBootstrap(
  db: DbClient,
  input: CompleteInitialBootstrapInput
): Promise<CompleteInitialBootstrapResult> {
  const instanceId = input.instanceId ?? DEFAULT_INSTANCE_ID;
  const email = input.ownerEmail.trim().toLowerCase();
  const displayName = input.ownerDisplayName.trim().slice(0, 64);

  return db.transaction(async (tx) => {
    const executor = tx as unknown as DbClient;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lobbyforge:setup:${instanceId}`}))`);

    const current = await getInstanceSetupStatus(executor, instanceId);
    if (current.bootstrapVersion >= 2) throw new SetupAlreadyCompleteError();
    let owner: { id: string; displayName: string; email: string };

    if (current.setupCompletedAt) {
      if (!current.ownerUserId) throw new Error('Setup is complete but the owner record is missing.');
      const [legacyOwner] = await tx
        .select({
          id: users.id,
          displayName: users.displayName,
          email: users.email,
          passwordHash: users.passwordHash,
        })
        .from(users)
        .where(eq(users.id, current.ownerUserId))
        .limit(1);
      const existingServers = await tx
        .select({ id: servers.id })
        .from(servers)
        .where(eq(servers.ownerUserId, current.ownerUserId))
        .limit(1);
      if (!legacyOwner || legacyOwner.email || legacyOwner.passwordHash || existingServers.length > 0) {
        throw new SetupAlreadyCompleteError();
      }
      const [updatedOwner] = await tx
        .update(users)
        .set({
          displayName,
          email,
          passwordHash: input.ownerPasswordHash,
          isGuest: false,
          updatedAt: input.now ?? new Date(),
        })
        .where(eq(users.id, legacyOwner.id))
        .returning({ id: users.id, displayName: users.displayName, email: users.email });
      if (!updatedOwner?.email) throw new Error('Owner credential update returned no row.');
      owner = { ...updatedOwner, email: updatedOwner.email };
    } else {
      const [createdOwner] = await tx
        .insert(users)
        .values({
          displayName,
          email,
          passwordHash: input.ownerPasswordHash,
          isGuest: false,
        })
        .returning({ id: users.id, displayName: users.displayName, email: users.email });
      if (!createdOwner?.email) throw new Error('Owner creation returned no row.');
      owner = { ...createdOwner, email: createdOwner.email };
    }

    const server = await createServer(executor, {
      name: input.instanceName.trim(),
      ownerUserId: owner.id,
      isPublic: input.registrationMode === 'open',
    });
    const setup = await completeInstanceSetup(executor, {
      instanceId,
      instanceName: input.instanceName,
      ownerUserId: owner.id,
      registrationMode: input.registrationMode,
      guestAccessEnabled: input.guestAccessEnabled,
      seoIndexingEnabled: input.seoIndexingEnabled,
      seoTitle: input.seoTitle,
      seoDescription: input.seoDescription,
      now: input.now,
    });
    return { setup, owner, server };
  });
}

/**
 * Create a non-guest user row for the first owner. There is no email
 * or password at /setup time — this is the instance bootstrap, and
 * the owner claims their account later via a magic-link or password
 * recovery flow (out of scope for M21).
 *
 * Returns the new user row, or the existing one if a user with the
 * same display name is already present. We don't enforce uniqueness
 * on displayName; the wizard uses this to keep setup idempotent in
 * the face of double-submit, which would otherwise create two owner
 * rows.
 */
export async function getOrCreateOwnerUser(
  db: DbClient,
  input: CreateOwnerUserInput
): Promise<{ id: string; displayName: string }> {
  const trimmed = input.displayName.trim().slice(0, 64);
  if (!trimmed) throw new Error('getOrCreateOwnerUser: displayName required');

  const [existing] = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(eq(users.displayName, trimmed))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(users)
    .values({
      displayName: trimmed,
      isGuest: false,
      locale: input.locale ?? 'en',
    })
    .returning({ id: users.id, displayName: users.displayName });
  if (!created) throw new Error('getOrCreateOwnerUser: insert returned no rows');
  return created;
}

/**
 * Update the instance logo (image data URL — validated by the API
 * route) or clear it with null. Used by the admin panel; the setup
 * wizard seeds it at bootstrap time.
 */
export async function setInstanceLogoUrl(
  db: DbClient,
  logoUrl: string | null,
  instanceId: string = DEFAULT_INSTANCE_ID
): Promise<string | null> {
  const [updated] = await db
    .update(instanceSettings)
    .set({ instanceLogoUrl: logoUrl, updatedAt: new Date() })
    .where(eq(instanceSettings.instanceId, instanceId))
    .returning({ instanceLogoUrl: instanceSettings.instanceLogoUrl });
  if (updated) return updated.instanceLogoUrl;
  const [inserted] = await db
    .insert(instanceSettings)
    .values({ instanceId, instanceName: DEFAULT_INSTANCE_NAME, instanceLogoUrl: logoUrl })
    .returning({ instanceLogoUrl: instanceSettings.instanceLogoUrl });
  return inserted?.instanceLogoUrl ?? null;
}
