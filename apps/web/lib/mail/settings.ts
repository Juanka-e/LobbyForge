/**
 * The effective mail and verification settings (docs/EMAIL.md §3): the
 * stored row (migration 0046) with the environment overrides on top
 * (§3.2), the preset defaults filled in and the SMTP password decrypted.
 * Server-only.
 *
 *   LOBBYFORGE_MAIL_PROVIDER        a registry id (ses, scaleway, …, custom, mailpit) or none
 *   LOBBYFORGE_SMTP_HOST            host name (alone: the provider counts as `custom`)
 *   LOBBYFORGE_SMTP_PORT            25, 465, 587, 2465, 2525, 2587 (1025/19525 in development)
 *   LOBBYFORGE_SMTP_SECURITY        tls | starttls | none (`none` only for localhost / mailpit)
 *   LOBBYFORGE_SMTP_USER            SMTP user name
 *   LOBBYFORGE_SMTP_PASSWORD        SMTP password (plaintext in the env; never stored, never returned)
 *   LOBBYFORGE_MAIL_FROM            e.g. `LobbyForge <no-reply@example.org>`
 *   LOBBYFORGE_EMAIL_VERIFICATION   off | optional | required (`off` is the emergency switch)
 *
 * An empty value counts as unset; an invalid one is ignored (logged once,
 * Doctor warns). An environment value is never copied into the database.
 *
 * Cached per process for 5 s on `globalThis` (the routes and the
 * restriction helper share it), invalidated by an admin save in that
 * process (a generation counter keeps an older read from putting old values
 * back). When the row cannot be read, the defaults apply — no transport,
 * verification as the environment says or `off` — cached for 3 s, the error
 * logged at most once a minute. Restrictions therefore fail OPEN during a
 * database outage (the restricted actions need the database anyway).
 *
 * `email_verification_enforced_since` is set the first time the effective
 * mode is `required` — by the admin save, or here when the environment
 * turned it on (one conditional UPDATE, then never moved).
 */
import {
  ensureEmailVerificationEnforcedSince,
  getInstanceMailSettings,
  defaultInstanceMailSettings,
  type InstanceMailSettings,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { createHmac } from 'node:crypto';
import { SMTP_SECRET_BOX, deriveSessionKey, openSecret, secretHint } from '@/lib/secret-box';
import { getMailProvider, presetHost, presetRegionForHost } from './providers';
import {
  isEmailVerificationMode,
  isMailProviderId,
  isSmtpSecurity,
  parseDisposableOverrides,
  parseEmailVerificationScope,
  type EmailVerificationMode,
  type EmailVerificationScope,
  type MailProviderSetting,
  type SmtpSecurity,
} from './types';

export type SmtpPasswordState = 'unset' | 'ok' | 'undecryptable';

export interface MailEnvOverrides {
  provider: MailProviderSetting | null;
  host: string | null;
  port: number | null;
  security: SmtpSecurity | null;
  username: string | null;
  password: string | null;
  from: string | null;
  verification: EmailVerificationMode | null;
  /** Variable names whose value was set but invalid (ignored; Doctor warns). */
  invalid: string[];
}

export interface MailLockedFields {
  provider: boolean;
  host: boolean;
  port: boolean;
  security: boolean;
  username: boolean;
  password: boolean;
  from: boolean;
  verification: boolean;
}

export interface ResolvedMailSettings {
  provider: MailProviderSetting;
  region: string | null;
  host: string | null;
  port: number | null;
  security: SmtpSecurity | null;
  username: string | null;
  /** Decrypted (or from the env). Server-only — never serialise this object to a client. */
  password: string | null;
  passwordState: SmtpPasswordState;
  passwordHint: string | null;
  from: string | null;
  dailyLimit: number | null;
  /**
   * The last test of the saved configuration. `current` is true only while
   * the configuration in force still has the fingerprint that test recorded
   * (see `mailTestFingerprint`): a test of other settings never counts.
   */
  lastTest: { at: Date | null; result: string | null; current: boolean };
  verification: {
    mode: EmailVerificationMode;
    scope: EmailVerificationScope;
    enforcedSince: Date | null;
    existingDeadline: Date | null;
  };
  disposable: { block: boolean; allow: string[]; blockExtra: string[] };
  locked: MailLockedFields;
  env: MailEnvOverrides;
  /** The row as stored (password still encrypted) — the admin PUT diffs against it. */
  stored: InstanceMailSettings;
  /** False when the row could not be read and the defaults stand in for it. */
  loaded: boolean;
  /** Enough to try a send: a provider, host, port, security and from, and a password that decrypts (if one is set). */
  transportConfigured: boolean;
}

const CACHE_KEY = '__lobbyforgeMailSettings__';
const CACHE_TTL_MS = 5_000;
const FAILURE_TTL_MS = 3_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

interface CacheHolder {
  slot?: { value: ResolvedMailSettings; expiresAt: number };
  pending?: Promise<ResolvedMailSettings>;
  generation: number;
  lastErrorLogAt?: number;
  warnedInvalid?: string;
}

function holder(): CacheHolder {
  const g = globalThis as unknown as Record<string, CacheHolder | undefined>;
  let value = g[CACHE_KEY];
  if (!value) {
    value = { generation: 0 };
    g[CACHE_KEY] = value;
  }
  return value;
}

function envValue(name: string): string | null {
  const trimmed = process.env[name]?.trim();
  return trimmed ? trimmed : null;
}

export function readMailEnvOverrides(): MailEnvOverrides {
  const invalid: string[] = [];
  const rawProvider = envValue('LOBBYFORGE_MAIL_PROVIDER')?.toLowerCase() ?? null;
  let provider: MailProviderSetting | null = null;
  if (rawProvider) {
    if (rawProvider === 'none' || isMailProviderId(rawProvider)) provider = rawProvider as MailProviderSetting;
    else invalid.push('LOBBYFORGE_MAIL_PROVIDER');
  }
  const rawPort = envValue('LOBBYFORGE_SMTP_PORT');
  let port: number | null = null;
  if (rawPort) {
    const n = Number(rawPort);
    if (Number.isInteger(n) && n > 0 && n < 65536) port = n;
    else invalid.push('LOBBYFORGE_SMTP_PORT');
  }
  const rawSecurity = envValue('LOBBYFORGE_SMTP_SECURITY')?.toLowerCase() ?? null;
  let security: SmtpSecurity | null = null;
  if (rawSecurity) {
    if (isSmtpSecurity(rawSecurity)) security = rawSecurity;
    else invalid.push('LOBBYFORGE_SMTP_SECURITY');
  }
  const rawVerification = envValue('LOBBYFORGE_EMAIL_VERIFICATION')?.toLowerCase() ?? null;
  let verification: EmailVerificationMode | null = null;
  if (rawVerification) {
    if (isEmailVerificationMode(rawVerification)) verification = rawVerification;
    else invalid.push('LOBBYFORGE_EMAIL_VERIFICATION');
  }
  const h = holder();
  const signature = invalid.join(',');
  if (signature && h.warnedInvalid !== signature) {
    h.warnedInvalid = signature;
    console.warn(`[mail] ignoring invalid environment values: ${invalid.join(', ')}`);
  }
  return {
    provider,
    host: envValue('LOBBYFORGE_SMTP_HOST')?.toLowerCase() ?? null,
    port,
    security,
    username: envValue('LOBBYFORGE_SMTP_USER'),
    password: envValue('LOBBYFORGE_SMTP_PASSWORD'),
    from: envValue('LOBBYFORGE_MAIL_FROM'),
    verification,
    invalid,
  };
}

/** 465 and 2465 are implicit TLS; every other submission port starts plain and upgrades. */
export function defaultSecurityForPort(port: number): SmtpSecurity {
  return port === 465 || port === 2465 ? 'tls' : 'starttls';
}

/** Pure: stored row + env → the effective settings. */
export function buildResolvedMailSettings(stored: InstanceMailSettings, env: MailEnvOverrides, loaded = true): ResolvedMailSettings {
  const resolved = buildWithoutTestState(stored, env, loaded);
  resolved.lastTest.current = lastTestIsCurrent(resolved);
  return resolved;
}

function buildWithoutTestState(stored: InstanceMailSettings, env: MailEnvOverrides, loaded: boolean): ResolvedMailSettings {
  const storedProvider: MailProviderSetting =
    stored.provider === 'none' || isMailProviderId(stored.provider) ? (stored.provider as MailProviderSetting) : 'none';
  // §3.2: an env host without an env provider counts as `custom`.
  const provider: MailProviderSetting = env.provider ?? (env.host ? 'custom' : storedProvider);
  const preset = provider === 'none' ? null : getMailProvider(provider);

  let region = stored.region;
  if (preset?.regions) {
    const fromHost = presetRegionForHost(preset, env.host ?? stored.smtpHost);
    region = fromHost ?? (region && preset.regions.some((r) => r.id === region) ? region : preset.regions[0]!.id);
  } else {
    region = null;
  }

  const host = provider === 'none' ? null : env.host ?? stored.smtpHost ?? (preset ? presetHost(preset, region) : null);
  const port = provider === 'none' ? null : env.port ?? stored.smtpPort ?? preset?.ports[0]?.port ?? null;
  const security =
    provider === 'none'
      ? null
      : env.security ??
        stored.smtpSecurity ??
        (port !== null ? preset?.ports.find((p) => p.port === port)?.security ?? defaultSecurityForPort(port) : null);

  let password: string | null;
  let passwordState: SmtpPasswordState;
  if (env.password) {
    password = env.password;
    passwordState = 'ok';
  } else if (stored.smtpPasswordEncrypted) {
    password = openSecret(stored.smtpPasswordEncrypted, SMTP_SECRET_BOX);
    passwordState = password === null ? 'undecryptable' : 'ok';
  } else {
    password = null;
    passwordState = 'unset';
  }

  const from = env.from ?? stored.mailFrom;
  const overrides = parseDisposableOverrides(stored.disposableOverrides);
  const mode = env.verification ?? stored.verificationMode;
  return {
    provider,
    region,
    host,
    port,
    security,
    username: env.username ?? stored.smtpUsername,
    password,
    passwordState,
    passwordHint: secretHint(password),
    from,
    dailyLimit: stored.dailyLimit,
    lastTest: { at: stored.lastTestAt, result: stored.lastTestResult, current: false },
    verification: {
      mode,
      scope: parseEmailVerificationScope(stored.verificationScope),
      enforcedSince: stored.enforcedSince,
      existingDeadline: stored.existingDeadline,
    },
    disposable: { block: stored.disposableBlock, allow: overrides.allow, blockExtra: overrides.block },
    locked: {
      provider: env.provider !== null || env.host !== null,
      host: env.host !== null,
      port: env.port !== null,
      security: env.security !== null,
      username: env.username !== null,
      password: env.password !== null,
      from: env.from !== null,
      verification: env.verification !== null,
    },
    env,
    stored,
    loaded,
    transportConfigured:
      provider !== 'none' && Boolean(host) && port !== null && security !== null && Boolean(from) && passwordState !== 'undecryptable',
  };
}

/** The connection a test exercises — every value that decides where the password goes and what is sent. */
export interface MailTestConnection {
  provider: MailProviderSetting;
  host: string | null;
  port: number | null;
  security: SmtpSecurity | null;
  username: string | null;
  password: string | null;
  from: string | null;
}

export const MAIL_TEST_FINGERPRINT_INFO = 'lobbyforge:mail-test-fingerprint:v1';

/**
 * HMAC-SHA256 (key derived from the session secret) of a test connection,
 * hex. Keyed, so the stored fingerprint gives no offline handle on the
 * password inside it. Null without a session secret.
 */
export function mailTestFingerprint(connection: MailTestConnection): string | null {
  try {
    const key = deriveSessionKey(MAIL_TEST_FINGERPRINT_INFO);
    const material = JSON.stringify([
      connection.provider,
      connection.host?.toLowerCase() ?? null,
      connection.port,
      connection.security,
      connection.username,
      connection.password,
      connection.from,
    ]);
    return createHmac('sha256', key).update(material).digest('hex');
  } catch {
    return null;
  }
}

export function connectionOf(settings: Pick<ResolvedMailSettings, 'provider' | 'host' | 'port' | 'security' | 'username' | 'password' | 'from'>): MailTestConnection {
  return {
    provider: settings.provider,
    host: settings.host,
    port: settings.port,
    security: settings.security,
    username: settings.username,
    password: settings.password,
    from: settings.from,
  };
}

/** Is the stored last test about exactly this configuration? */
function lastTestIsCurrent(settings: ResolvedMailSettings): boolean {
  const recorded = settings.stored.lastTestFingerprint;
  if (!recorded || !settings.lastTest.result) return false;
  return mailTestFingerprint(connectionOf(settings)) === recorded;
}

async function load(h: CacheHolder): Promise<ResolvedMailSettings> {
  const env = readMailEnvOverrides();
  let stored: InstanceMailSettings;
  try {
    stored = await getInstanceMailSettings(getDb());
  } catch (error) {
    const now = Date.now();
    if (!h.lastErrorLogAt || now - h.lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
      h.lastErrorLogAt = now;
      console.error('[mail] settings could not be read; using the defaults', JSON.stringify((error as Error).message));
    }
    return buildResolvedMailSettings(defaultInstanceMailSettings(), env, false);
  }
  const resolved = buildResolvedMailSettings(stored, env);
  if (resolved.verification.mode === 'required' && !resolved.verification.enforcedSince) {
    try {
      const since = await ensureEmailVerificationEnforcedSince(getDb());
      if (since) resolved.verification.enforcedSince = since;
    } catch (error) {
      console.error('[mail] could not record when verification became required', JSON.stringify((error as Error).message));
    }
  }
  return resolved;
}

/** The effective settings, from the per-process cache when fresh. `fresh` bypasses (and refills) it — the admin API reads with it. */
export async function resolveMailSettings(options: { fresh?: boolean } = {}): Promise<ResolvedMailSettings> {
  const h = holder();
  const now = Date.now();
  if (!options.fresh && h.slot && h.slot.expiresAt > now) return h.slot.value;
  if (!options.fresh && h.pending) return h.pending;
  const generation = h.generation;
  const pending = load(h).then((value) => {
    if (h.generation === generation) {
      h.slot = { value, expiresAt: Date.now() + (value.loaded ? CACHE_TTL_MS : FAILURE_TTL_MS) };
    }
    return value;
  });
  h.pending = pending;
  try {
    return await pending;
  } finally {
    if (h.pending === pending) h.pending = undefined;
  }
}

/** Forget the cached settings (after a save). Reads already running cannot put old values back. */
export function invalidateMailSettingsCache(): void {
  const h = holder();
  h.generation += 1;
  h.slot = undefined;
  h.pending = undefined;
}

/** Test-only. */
export function resetMailSettingsCacheForTests(): void {
  const g = globalThis as unknown as Record<string, CacheHolder | undefined>;
  g[CACHE_KEY] = undefined;
}
