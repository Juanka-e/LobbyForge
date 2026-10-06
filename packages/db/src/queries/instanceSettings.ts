import { and, eq, isNull, sql } from 'drizzle-orm';
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

// ---- Bot protection (0045, docs/CAPTCHA.md §3.1) ---------------------------

export type CaptchaProviderSetting = 'none' | 'altcha' | 'turnstile' | 'recaptcha';

export const CAPTCHA_PROVIDER_SETTINGS: readonly CaptchaProviderSetting[] = ['none', 'altcha', 'turnstile', 'recaptcha'];

/** The column defaults of 0045 — also what an instance without a settings row gets. */
export const DEFAULT_CAPTCHA_SURFACES = Object.freeze({
  register: 'on',
  invite_register: 'off',
  guest: 'on',
  login: 'adaptive',
}) as Readonly<Record<'register' | 'invite_register' | 'guest' | 'login', string>>;

/**
 * The stored bot protection settings, as they are in the row. `surfaces` and
 * `options` are raw JSON: the web app validates them and fills in defaults
 * (it owns the vocabulary). The secret stays encrypted here; decrypting it
 * needs the session secret, which this package never sees.
 */
export interface InstanceCaptchaSettings {
  instanceId: string;
  provider: CaptchaProviderSetting;
  surfaces: unknown;
  siteKey: string | null;
  secretEncrypted: string | null;
  options: unknown;
  attackMode: boolean;
  updatedAt: Date | null;
}

/**
 * A partial update: a field left `undefined` keeps its stored value; `null`
 * clears a nullable one (`siteKey`, `secretEncrypted`).
 */
export interface SetInstanceCaptchaSettingsInput {
  instanceId?: string;
  provider?: CaptchaProviderSetting;
  surfaces?: Record<string, string>;
  siteKey?: string | null;
  secretEncrypted?: string | null;
  options?: Record<string, unknown>;
  attackMode?: boolean;
  now?: Date;
}

function toCaptchaSettings(row: typeof instanceSettings.$inferSelect): InstanceCaptchaSettings {
  return {
    instanceId: row.instanceId,
    provider: (CAPTCHA_PROVIDER_SETTINGS as readonly string[]).includes(row.captchaProvider)
      ? (row.captchaProvider as CaptchaProviderSetting)
      : 'altcha',
    surfaces: row.captchaSurfaces,
    siteKey: row.captchaSiteKey,
    secretEncrypted: row.captchaSecretEncrypted,
    options: row.captchaOptions,
    attackMode: row.captchaAttackMode,
    updatedAt: row.updatedAt,
  };
}

/** The stored bot protection settings, or the 0045 defaults when there is no settings row yet. */
export async function getInstanceCaptchaSettings(
  db: DbClient,
  instanceId = DEFAULT_INSTANCE_ID
): Promise<InstanceCaptchaSettings> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.instanceId, instanceId))
    .limit(1);
  if (row) return toCaptchaSettings(row);
  return {
    instanceId,
    provider: 'altcha',
    surfaces: { ...DEFAULT_CAPTCHA_SURFACES },
    siteKey: null,
    secretEncrypted: null,
    options: {},
    attackMode: false,
    updatedAt: null,
  };
}

/**
 * Save the bot protection settings (a partial update — see the input type).
 * Creates the settings row when it does not exist yet, like the other
 * instance setters. Returns the stored result.
 */
export async function setInstanceCaptchaSettings(
  db: DbClient,
  input: SetInstanceCaptchaSettingsInput
): Promise<InstanceCaptchaSettings> {
  const instanceId = input.instanceId ?? DEFAULT_INSTANCE_ID;
  const now = input.now ?? new Date();
  const values: Partial<typeof instanceSettings.$inferInsert> = { updatedAt: now };
  if (input.provider !== undefined) values.captchaProvider = input.provider;
  if (input.surfaces !== undefined) values.captchaSurfaces = input.surfaces;
  if (input.siteKey !== undefined) values.captchaSiteKey = input.siteKey;
  if (input.secretEncrypted !== undefined) values.captchaSecretEncrypted = input.secretEncrypted;
  if (input.options !== undefined) values.captchaOptions = input.options;
  if (input.attackMode !== undefined) values.captchaAttackMode = input.attackMode;

  const [updated] = await db
    .update(instanceSettings)
    .set(values)
    .where(eq(instanceSettings.instanceId, instanceId))
    .returning();
  if (updated) return toCaptchaSettings(updated);

  const [inserted] = await db
    .insert(instanceSettings)
    .values({ instanceId, instanceName: DEFAULT_INSTANCE_NAME, ...values })
    .onConflictDoUpdate({ target: instanceSettings.instanceId, set: values })
    .returning();
  if (!inserted) throw new Error('setInstanceCaptchaSettings: insert returned no rows');
  return toCaptchaSettings(inserted);
}

// ---- Email (0046, docs/EMAIL.md §3.1) --------------------------------------

export type EmailVerificationModeSetting = 'off' | 'optional' | 'required';
export const EMAIL_VERIFICATION_MODE_SETTINGS: readonly EmailVerificationModeSetting[] = ['off', 'optional', 'required'];
export type SmtpSecuritySetting = 'tls' | 'starttls' | 'none';
export const SMTP_SECURITY_SETTINGS: readonly SmtpSecuritySetting[] = ['tls', 'starttls', 'none'];

/** The column defaults of 0046 — also what an instance without a settings row gets. */
export const DEFAULT_EMAIL_VERIFICATION_SCOPE = Object.freeze({ open_register: true, invite_register: false }) as Readonly<{
  open_register: boolean;
  invite_register: boolean;
}>;
export const DEFAULT_DISPOSABLE_EMAIL_OVERRIDES = Object.freeze({ allow: [], block: [] }) as Readonly<{
  allow: readonly string[];
  block: readonly string[];
}>;

/**
 * The stored mail + verification settings, as they are in the row. `scope`
 * and `disposableOverrides` are raw JSON: the web app validates them (it
 * owns the vocabulary). The SMTP password stays encrypted here; decrypting
 * it needs the session secret, which this package never sees.
 */
export interface InstanceMailSettings {
  instanceId: string;
  /** A provider registry id (`ses`, `custom`, …) or `none`. */
  provider: string;
  region: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: SmtpSecuritySetting | null;
  smtpUsername: string | null;
  smtpPasswordEncrypted: string | null;
  mailFrom: string | null;
  dailyLimit: number | null;
  lastTestAt: Date | null;
  lastTestResult: string | null;
  /** HMAC of the connection the last test ran against (the web app computes it). */
  lastTestFingerprint: string | null;
  verificationMode: EmailVerificationModeSetting;
  verificationScope: unknown;
  enforcedSince: Date | null;
  existingDeadline: Date | null;
  disposableBlock: boolean;
  disposableOverrides: unknown;
  updatedAt: Date | null;
}

/** A partial update: `undefined` keeps the stored value, `null` clears a nullable one. */
export interface SetInstanceMailSettingsInput {
  instanceId?: string;
  provider?: string;
  region?: string | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecurity?: SmtpSecuritySetting | null;
  smtpUsername?: string | null;
  smtpPasswordEncrypted?: string | null;
  mailFrom?: string | null;
  dailyLimit?: number | null;
  lastTestAt?: Date | null;
  lastTestResult?: string | null;
  lastTestFingerprint?: string | null;
  verificationMode?: EmailVerificationModeSetting;
  verificationScope?: Record<string, boolean>;
  enforcedSince?: Date | null;
  existingDeadline?: Date | null;
  disposableBlock?: boolean;
  disposableOverrides?: { allow: string[]; block: string[] };
  now?: Date;
}

function toMailSettings(row: typeof instanceSettings.$inferSelect): InstanceMailSettings {
  return {
    instanceId: row.instanceId,
    provider: row.mailProvider,
    region: row.mailRegion,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecurity: (SMTP_SECURITY_SETTINGS as readonly string[]).includes(row.smtpSecurity ?? '')
      ? (row.smtpSecurity as SmtpSecuritySetting)
      : null,
    smtpUsername: row.smtpUsername,
    smtpPasswordEncrypted: row.smtpPasswordEncrypted,
    mailFrom: row.mailFrom,
    dailyLimit: row.mailDailyLimit,
    lastTestAt: row.mailLastTestAt,
    lastTestResult: row.mailLastTestResult,
    lastTestFingerprint: row.mailLastTestFingerprint,
    verificationMode: (EMAIL_VERIFICATION_MODE_SETTINGS as readonly string[]).includes(row.emailVerificationMode)
      ? (row.emailVerificationMode as EmailVerificationModeSetting)
      : 'off',
    verificationScope: row.emailVerificationScope,
    enforcedSince: row.emailVerificationEnforcedSince,
    existingDeadline: row.emailVerificationExistingDeadline,
    disposableBlock: row.disposableEmailBlock,
    disposableOverrides: row.disposableEmailOverrides,
    updatedAt: row.updatedAt,
  };
}

/** The 0046 defaults: no transport, verification off. */
export function defaultInstanceMailSettings(instanceId = DEFAULT_INSTANCE_ID): InstanceMailSettings {
  return {
    instanceId,
    provider: 'none',
    region: null,
    smtpHost: null,
    smtpPort: null,
    smtpSecurity: null,
    smtpUsername: null,
    smtpPasswordEncrypted: null,
    mailFrom: null,
    dailyLimit: null,
    lastTestAt: null,
    lastTestResult: null,
    lastTestFingerprint: null,
    verificationMode: 'off',
    verificationScope: { ...DEFAULT_EMAIL_VERIFICATION_SCOPE },
    enforcedSince: null,
    existingDeadline: null,
    disposableBlock: false,
    disposableOverrides: { allow: [], block: [] },
    updatedAt: null,
  };
}

/** The stored mail settings, or the 0046 defaults when there is no settings row yet. */
export async function getInstanceMailSettings(
  db: DbClient,
  instanceId = DEFAULT_INSTANCE_ID
): Promise<InstanceMailSettings> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.instanceId, instanceId))
    .limit(1);
  return row ? toMailSettings(row) : defaultInstanceMailSettings(instanceId);
}

/**
 * Save the mail settings (a partial update — see the input type). Creates
 * the settings row when it does not exist yet. Returns the stored result.
 */
export async function setInstanceMailSettings(
  db: DbClient,
  input: SetInstanceMailSettingsInput
): Promise<InstanceMailSettings> {
  const instanceId = input.instanceId ?? DEFAULT_INSTANCE_ID;
  const now = input.now ?? new Date();
  const values: Partial<typeof instanceSettings.$inferInsert> = { updatedAt: now };
  if (input.provider !== undefined) values.mailProvider = input.provider;
  if (input.region !== undefined) values.mailRegion = input.region;
  if (input.smtpHost !== undefined) values.smtpHost = input.smtpHost;
  if (input.smtpPort !== undefined) values.smtpPort = input.smtpPort;
  if (input.smtpSecurity !== undefined) values.smtpSecurity = input.smtpSecurity;
  if (input.smtpUsername !== undefined) values.smtpUsername = input.smtpUsername;
  if (input.smtpPasswordEncrypted !== undefined) values.smtpPasswordEncrypted = input.smtpPasswordEncrypted;
  if (input.mailFrom !== undefined) values.mailFrom = input.mailFrom;
  if (input.dailyLimit !== undefined) values.mailDailyLimit = input.dailyLimit;
  if (input.lastTestAt !== undefined) values.mailLastTestAt = input.lastTestAt;
  if (input.lastTestResult !== undefined) values.mailLastTestResult = input.lastTestResult;
  if (input.lastTestFingerprint !== undefined) values.mailLastTestFingerprint = input.lastTestFingerprint;
  if (input.verificationMode !== undefined) values.emailVerificationMode = input.verificationMode;
  if (input.verificationScope !== undefined) values.emailVerificationScope = input.verificationScope;
  if (input.enforcedSince !== undefined) values.emailVerificationEnforcedSince = input.enforcedSince;
  if (input.existingDeadline !== undefined) values.emailVerificationExistingDeadline = input.existingDeadline;
  if (input.disposableBlock !== undefined) values.disposableEmailBlock = input.disposableBlock;
  if (input.disposableOverrides !== undefined) values.disposableEmailOverrides = input.disposableOverrides;

  const [updated] = await db
    .update(instanceSettings)
    .set(values)
    .where(eq(instanceSettings.instanceId, instanceId))
    .returning();
  if (updated) return toMailSettings(updated);

  const [inserted] = await db
    .insert(instanceSettings)
    .values({ instanceId, instanceName: DEFAULT_INSTANCE_NAME, ...values })
    .onConflictDoUpdate({ target: instanceSettings.instanceId, set: values })
    .returning();
  if (!inserted) throw new Error('setInstanceMailSettings: insert returned no rows');
  return toMailSettings(inserted);
}

/**
 * Record the result of a test send against the SAVED configuration
 * (docs/EMAIL.md §5), with the fingerprint of the configuration it tested:
 * `required` unlocks only while the saved configuration still has that
 * fingerprint. Does not touch `updated_at`: a test is not a change of
 * settings. No-op when there is no settings row.
 */
export async function recordInstanceMailTest(
  db: DbClient,
  input: { result: string; fingerprint: string | null; at?: Date; instanceId?: string }
): Promise<void> {
  await db
    .update(instanceSettings)
    .set({ mailLastTestAt: input.at ?? new Date(), mailLastTestResult: input.result, mailLastTestFingerprint: input.fingerprint })
    .where(eq(instanceSettings.instanceId, input.instanceId ?? DEFAULT_INSTANCE_ID));
}

/**
 * `email_verification_enforced_since` is set the first time the mode is
 * `required` (docs/EMAIL.md §3.1) and never moved afterwards. Sets it to
 * `now` when it is still null, and returns the value in force (null when
 * there is no settings row to write to).
 */
export async function ensureEmailVerificationEnforcedSince(
  db: DbClient,
  input: { now?: Date; instanceId?: string } = {}
): Promise<Date | null> {
  const instanceId = input.instanceId ?? DEFAULT_INSTANCE_ID;
  const [updated] = await db
    .update(instanceSettings)
    .set({ emailVerificationEnforcedSince: input.now ?? new Date() })
    .where(and(eq(instanceSettings.instanceId, instanceId), isNull(instanceSettings.emailVerificationEnforcedSince)))
    .returning({ enforcedSince: instanceSettings.emailVerificationEnforcedSince });
  if (updated) return updated.enforcedSince;
  const [row] = await db
    .select({ enforcedSince: instanceSettings.emailVerificationEnforcedSince })
    .from(instanceSettings)
    .where(eq(instanceSettings.instanceId, instanceId))
    .limit(1);
  return row?.enforcedSince ?? null;
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
          signupChannel: 'setup',
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
          signupChannel: 'setup',
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
/**
 * 17th-audit: directory verification config — the .well-known producer
 * endpoint reads these fields to serve the registration proof document
 * the official registry fetches.
 */
export interface DirectoryVerificationConfig {
  /**
   * security-review HUB-001: this install's identity in the official
   * directory (random per install, migration 0039) — the id the instance
   * registers under and the one its proof signs. Never the settings
   * singleton key, which is the same on every install.
   */
  directoryInstanceId: string;
  domain: string | null;
  publicKey: string | null;
  isPublicDirectoryEnabled: boolean;
  directoryProof: string | null;
}

/**
 * security-review HUB-001: the directory config could not be saved because
 * the instance settings row does not exist yet (setup has not run). The
 * old setter silently updated nothing and the admin route said `ok`.
 */
export class DirectoryConfigNotInitializedError extends Error {
  constructor() {
    super('Instance settings are not initialised — finish /setup before configuring the directory');
    this.name = 'DirectoryConfigNotInitializedError';
  }
}

export async function getDirectoryVerificationConfig(
  db: DbClient
): Promise<DirectoryVerificationConfig | null> {
  // 18th-audit: explicit singleton WHERE — the table is a singleton by
  // design, but a second row shouldn't silently change which config
  // the .well-known endpoint serves.
  // security-review HUB-001: the singleton row is DEFAULT_INSTANCE_ID; a
  // local `'default'` used to shadow it, so this read a row that never
  // exists and `.well-known` 404'd on every install.
  const [row] = await db
    .select({
      directoryInstanceId: instanceSettings.directoryInstanceId,
      domain: instanceSettings.domain,
      publicKey: instanceSettings.publicKey,
      isPublicDirectoryEnabled: instanceSettings.isPublicDirectoryEnabled,
      directoryProof: instanceSettings.directoryProof,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.instanceId, DEFAULT_INSTANCE_ID))
    .limit(1);
  return row ?? null;
}

/**
 * 18th-audit: owner-only directory verification configuration. Returns
 * the install's directory id (the id the stored proof must sign).
 * security-review HUB-001: writes the real singleton row and throws
 * DirectoryConfigNotInitializedError when there is none, instead of
 * silently updating zero rows.
 */
export async function setDirectoryVerificationConfig(
  db: DbClient,
  input: {
    domain: string;
    publicKey: string;
    directoryProof: string;
    isPublicDirectoryEnabled: boolean;
  }
): Promise<{ directoryInstanceId: string }> {
  const [updated] = await db
    .update(instanceSettings)
    .set({
      domain: input.domain,
      publicKey: input.publicKey,
      directoryProof: input.directoryProof,
      isPublicDirectoryEnabled: input.isPublicDirectoryEnabled,
      updatedAt: new Date(),
    })
    .where(eq(instanceSettings.instanceId, DEFAULT_INSTANCE_ID))
    .returning({ directoryInstanceId: instanceSettings.directoryInstanceId });
  if (!updated) throw new DirectoryConfigNotInitializedError();
  return updated;
}

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
