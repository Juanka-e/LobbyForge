/**
 * The admin side of email (docs/EMAIL.md §5): the GET view, the PUT update
 * rules and the test send. The routes under `app/api/admin/mail` are thin
 * wrappers around these.
 *
 * The SMTP password never leaves the server: the view carries `passwordSet`
 * and `passwordHint` ("…abcd") only, and the audit entry field names only.
 * Nor does it follow the admin to a new place: the stored (or environment)
 * password is only ever sent to the host, provider and user it was saved
 * with. Pointing the connection elsewhere — on a save or a test — needs the
 * password typed again (400 `password_required`).
 */
import { z } from 'zod';
import { recordInstanceMailTest, setInstanceMailSettings, type InstanceMailSettings, type SetInstanceMailSettingsInput } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { SMTP_SECRET_BOX, sealSecret } from '@/lib/secret-box';
import { normaliseDomainEntry } from './disposable';
import { staticSmtpTargetRefusal } from './host-rules';
import { getMailProvider, mailpitOffered, presetHost } from './providers';
import { deliverMail, instanceDisplayName, parseFromAddress, smtpTargetContext } from './send';
import {
  buildResolvedMailSettings,
  connectionOf,
  defaultSecurityForPort,
  invalidateMailSettingsCache,
  mailTestFingerprint,
  resolveMailSettings,
  type MailLockedFields,
  type ResolvedMailSettings,
} from './settings';
import { countSend, recordMailSuccess, sentToday } from './stats';
import { mailLocale } from './templates';
import { closePooledTransport, createSmtpTransport, type SmtpConfig } from './transport';
import { REQUIRED_TEST_MAX_AGE_MS } from './types';
import {
  EMAIL_VERIFICATION_MODES,
  EmailAddressSchema,
  MAIL_PROVIDER_IDS,
  MAIL_TEST_RESULTS,
  SMTP_SECURITY_MODES,
  type EmailVerificationMode,
  type EmailVerificationScope,
  type MailOutcome,
  type MailProviderSetting,
  type MailTestResult,
  type SmtpSecurity,
} from './types';

export interface AdminMailView {
  provider: MailProviderSetting;
  region: string | null;
  host: string | null;
  port: number | null;
  security: SmtpSecurity | null;
  username: string | null;
  passwordSet: boolean;
  passwordHint: string | null;
  from: string | null;
  dailyLimit: number | null;
  sentToday: number;
  lastTest: { at: string | null; result: MailTestResult | null };
  verification: { mode: EmailVerificationMode; scope: EmailVerificationScope; enforcedSince: string | null; existingDeadline: string | null };
  disposable: { block: boolean; allow: string[]; blockExtra: string[] };
  locked: MailLockedFields;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function testResult(value: string | null): MailTestResult | null {
  return value && (MAIL_TEST_RESULTS as readonly string[]).includes(value) ? (value as MailTestResult) : null;
}

export async function buildAdminMailView(settings: ResolvedMailSettings): Promise<AdminMailView> {
  // A test of other settings than the ones in force says nothing about them.
  const lastTest = settings.lastTest.current
    ? { at: iso(settings.lastTest.at), result: testResult(settings.lastTest.result) }
    : { at: null, result: null };
  return {
    provider: settings.provider,
    region: settings.region,
    host: settings.host,
    port: settings.port,
    security: settings.security,
    username: settings.username,
    passwordSet: settings.passwordState !== 'unset',
    passwordHint: settings.passwordHint,
    from: settings.from,
    dailyLimit: settings.dailyLimit,
    sentToday: await sentToday(),
    lastTest,
    verification: {
      mode: settings.verification.mode,
      scope: settings.verification.scope,
      enforcedSince: iso(settings.verification.enforcedSince),
      existingDeadline: iso(settings.verification.existingDeadline),
    },
    disposable: settings.disposable,
    locked: settings.locked,
  };
}

/** '' (an empty form field) reads as null. */
const blankToNull = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? null : value);
/** '' (an empty write-only field) reads as "not given". */
const blankToUndefined = (value: unknown) => (typeof value === 'string' && value === '' ? undefined : value);

const ProviderSchema = z.union([z.literal('none'), z.enum(MAIL_PROVIDER_IDS)]);
const DomainList = z.array(z.string().max(253)).max(1000);

export const AdminMailUpdateSchema = z
  .object({
    provider: ProviderSchema,
    region: z.preprocess(blankToNull, z.string().trim().regex(/^[a-z0-9-]{1,32}$/).nullable().optional()),
    host: z.preprocess(blankToNull, z.string().trim().toLowerCase().min(1).max(253).nullable().optional()),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    security: z.enum(SMTP_SECURITY_MODES).nullable().optional(),
    username: z.preprocess(blankToNull, z.string().trim().min(1).max(256).nullable().optional()),
    // A string sets a new password, null clears it, omitted (or '') keeps it.
    password: z.preprocess(blankToUndefined, z.string().min(1).max(512).nullable().optional()),
    from: z.preprocess(blankToNull, z.string().trim().min(3).max(320).nullable().optional()),
    dailyLimit: z.number().int().min(1).max(10_000_000).nullable().optional(),
    verification: z
      .object({
        mode: z.enum(EMAIL_VERIFICATION_MODES),
        scope: z.object({ open_register: z.boolean(), invite_register: z.boolean() }).strict(),
        existingDeadline: z.string().datetime({ offset: true }).nullable().optional(),
      })
      .strict(),
    disposable: z.object({ block: z.boolean(), allow: DomainList, blockExtra: DomainList }).strict(),
  })
  .strict();

export type AdminMailUpdate = z.infer<typeof AdminMailUpdateSchema>;

export type AdminRefusal = { ok: false; status: 400 | 409 | 503; body: Record<string, unknown> };
export type AdminMailUpdateResult = { ok: true; view: AdminMailView; changedFields: string[] } | AdminRefusal;

function invalid(path: string, message: string): AdminRefusal {
  return { ok: false, status: 400, body: { error: 'invalid_settings', issues: [{ path, message }] } };
}

const lockedByEnv = (field: keyof MailLockedFields): AdminRefusal => ({ ok: false, status: 409, body: { error: 'locked_by_env', field } });
const passwordRequired: AdminRefusal = { ok: false, status: 400, body: { error: 'password_required' } };

function normaliseList(list: string[], path: string): { ok: true; value: string[] } | { ok: false; result: AdminRefusal } {
  const out = new Set<string>();
  for (const [index, raw] of list.entries()) {
    if (!raw.trim()) continue;
    const domain = normaliseDomainEntry(raw);
    if (!domain) return { ok: false, result: invalid(`${path}.${index}`, 'invalid_domain') };
    out.add(domain);
  }
  return { ok: true, value: [...out] };
}

/** Where the password goes: the provider, the host and the user it authenticates as. */
function passwordDestinationChanged(
  before: Pick<ResolvedMailSettings, 'provider' | 'host' | 'username'>,
  after: Pick<ResolvedMailSettings, 'provider' | 'host' | 'username'>
): boolean {
  return before.provider !== after.provider || (before.host ?? null) !== (after.host ?? null) || (before.username ?? null) !== (after.username ?? null);
}

/**
 * Apply a PUT (docs/EMAIL.md §5):
 *   - environment-locked fields refuse a DIFFERENT value (409 `locked_by_env`);
 *   - pointing the saved password at another provider, host or user needs it
 *     typed again (400 `password_required`; 409 `locked_by_env` / `password`
 *     when it comes from the environment);
 *   - the host passes the §3.4 rules that need no DNS (400 `host_not_allowed`);
 *   - while the resulting mode is `required`, the resulting configuration
 *     must be a working transport (409 `transport_required`);
 *   - switching TO `required` needs a passing test of exactly the resulting
 *     configuration (409 `test_required`: the recorded fingerprint must match).
 */
export async function applyAdminMailUpdate(update: AdminMailUpdate): Promise<AdminMailUpdateResult> {
  const current = await resolveMailSettings({ fresh: true });
  if (!current.loaded) return { ok: false, status: 503, body: { error: 'settings_unavailable' } };
  const stored = current.stored;
  const locked = current.locked;

  if (locked.provider && update.provider !== current.provider) return lockedByEnv('provider');
  if (locked.host && update.host !== undefined && (update.host ?? null) !== current.host) return lockedByEnv('host');
  if (locked.port && update.port !== undefined && (update.port ?? null) !== current.port) return lockedByEnv('port');
  if (locked.security && update.security !== undefined && (update.security ?? null) !== current.security) return lockedByEnv('security');
  if (locked.username && update.username !== undefined && (update.username ?? null) !== current.username) return lockedByEnv('username');
  if (locked.password && update.password !== undefined) return lockedByEnv('password');
  if (locked.from && update.from !== undefined && (update.from ?? null) !== current.from) return lockedByEnv('from');
  if (locked.verification && update.verification.mode !== current.verification.mode) return lockedByEnv('verification');

  const context = smtpTargetContext();
  const provider: MailProviderSetting = locked.provider ? current.provider : update.provider;
  const preset = provider === 'none' ? null : getMailProvider(provider);
  // Offered on every instance but the official hub (§2.2); the host rules
  // (§3.4) then accept only what the environment can reach.
  if (provider === 'mailpit' && !mailpitOffered(context)) return invalid('provider', 'not_offered');

  let region: string | null = null;
  if (preset?.regions) {
    region = update.region ?? stored.region ?? preset.regions[0]!.id;
    if (!preset.regions.some((r) => r.id === region)) return invalid('region', 'unknown_region');
  }

  const allow = normaliseList(update.disposable.allow, 'disposable.allow');
  if (!allow.ok) return allow.result;
  const blockExtra = normaliseList(update.disposable.blockExtra, 'disposable.blockExtra');
  if (!blockExtra.ok) return blockExtra.result;
  const existingDeadline = update.verification.existingDeadline ? new Date(update.verification.existingDeadline) : null;

  // The write: only the columns that change (locked ones never).
  const write: SetInstanceMailSettingsInput = {};
  const changed: string[] = [];
  const set = <K extends keyof SetInstanceMailSettingsInput>(field: string, key: K, next: SetInstanceMailSettingsInput[K], before: unknown) => {
    const same =
      next instanceof Date || before instanceof Date
        ? iso(next as Date | null) === iso(before as Date | null)
        : JSON.stringify(next ?? null) === JSON.stringify(before ?? null);
    if (same) return;
    write[key] = next;
    changed.push(field);
  };
  if (!locked.provider) set('provider', 'provider', provider, stored.provider);
  set('region', 'region', region, stored.region);
  if (!locked.host && update.host !== undefined) set('host', 'smtpHost', update.host ?? null, stored.smtpHost);
  if (!locked.port && update.port !== undefined) set('port', 'smtpPort', update.port ?? null, stored.smtpPort);
  if (!locked.security && update.security !== undefined) set('security', 'smtpSecurity', update.security ?? null, stored.smtpSecurity);
  if (!locked.username && update.username !== undefined) set('username', 'smtpUsername', update.username ?? null, stored.smtpUsername);
  if (!locked.password && update.password !== undefined) {
    if (update.password === null) {
      if (stored.smtpPasswordEncrypted) {
        write.smtpPasswordEncrypted = null;
        changed.push('password');
      }
    } else if (update.password !== current.password || current.passwordState !== 'ok') {
      write.smtpPasswordEncrypted = sealSecret(update.password, SMTP_SECRET_BOX);
      changed.push('password');
    }
  }
  if (!locked.from && update.from !== undefined) set('from', 'mailFrom', update.from ?? null, stored.mailFrom);
  set('dailyLimit', 'dailyLimit', update.dailyLimit ?? null, stored.dailyLimit);
  if (!locked.verification) set('verificationMode', 'verificationMode', update.verification.mode, stored.verificationMode);
  set('verificationScope', 'verificationScope', update.verification.scope, current.verification.scope);
  set('existingDeadline', 'existingDeadline', existingDeadline, stored.existingDeadline);
  set('disposableBlock', 'disposableBlock', update.disposable.block, stored.disposableBlock);
  const allowChanged = JSON.stringify(allow.value) !== JSON.stringify(current.disposable.allow);
  const blockChanged = JSON.stringify(blockExtra.value) !== JSON.stringify(current.disposable.blockExtra);
  if (allowChanged || blockChanged) {
    write.disposableOverrides = { allow: allow.value, block: blockExtra.value };
    if (allowChanged) changed.push('disposableAllow');
    if (blockChanged) changed.push('disposableBlockExtra');
  }

  // The configuration that would be in force after the save (env included).
  const nextStored: InstanceMailSettings = { ...stored, ...(write as Partial<InstanceMailSettings>) };
  const resulting = buildResolvedMailSettings(nextStored, current.env);

  // The saved password must not follow the connection somewhere else. A
  // result that sends no password (no transport, or no user) needs nothing;
  // a move FROM no transport to a host is a move like any other, so parking
  // the transport on `none` first cannot launder the stored password.
  const resultUsesPassword = resulting.provider !== 'none' && Boolean(resulting.username);
  if (current.password !== null && update.password === undefined && resultUsesPassword && passwordDestinationChanged(current, resulting)) {
    return locked.password ? lockedByEnv('password') : passwordRequired;
  }

  if (resulting.provider !== 'none') {
    if (!resulting.host) return invalid('host', 'required');
    if (resulting.port === null) return invalid('port', 'required');
    const security = resulting.security ?? preset?.ports.find((p) => p.port === resulting.port)?.security ?? defaultSecurityForPort(resulting.port);
    const refusal = staticSmtpTargetRefusal({ host: resulting.host, port: resulting.port, security }, context);
    if (refusal && !refusal.ok) return { ok: false, status: 400, body: { error: 'host_not_allowed', detail: refusal.detail } };
    if (!resulting.from) return invalid('from', 'required');
    if (!parseFromAddress(resulting.from)) return invalid('from', 'invalid_address');
  } else if (resulting.from && !parseFromAddress(resulting.from)) {
    return invalid('from', 'invalid_address');
  }

  const nextMode = resulting.verification.mode;
  // `required` with mail that cannot go out would lock every new account out.
  if (nextMode === 'required' && !resulting.transportConfigured) {
    return { ok: false, status: 409, body: { error: 'transport_required' } };
  }
  if (nextMode === 'required' && current.verification.mode !== 'required') {
    // §4.2: a passing test of EXACTLY what will be in force.
    // The test must also be recent: credentials revoked at the provider since
    // a weeks-old test would otherwise still unlock `required`.
    const fingerprint = mailTestFingerprint(connectionOf(resulting));
    const recent =
      stored.lastTestAt instanceof Date && Date.now() - stored.lastTestAt.getTime() <= REQUIRED_TEST_MAX_AGE_MS;
    const tested =
      stored.lastTestResult === 'ok' && recent && fingerprint !== null && stored.lastTestFingerprint === fingerprint;
    if (!tested) return { ok: false, status: 409, body: { error: 'test_required' } };
  }
  if (nextMode === 'required' && !stored.enforcedSince) write.enforcedSince = new Date();

  if (Object.keys(write).length > 0) await setInstanceMailSettings(getDb(), write);
  invalidateMailSettingsCache();
  if (passwordDestinationChanged(current, resulting) || changed.some((f) => ['port', 'security', 'password'].includes(f))) closePooledTransport();
  const view = await buildAdminMailView(await resolveMailSettings({ fresh: true }));
  return { ok: true, view, changedFields: changed };
}

export const AdminMailTestSchema = z
  .object({
    to: z.preprocess(blankToUndefined, z.string().max(320).optional()),
    provider: ProviderSchema.optional(),
    region: z.preprocess(blankToNull, z.string().trim().regex(/^[a-z0-9-]{1,32}$/).nullable().optional()),
    host: z.preprocess(blankToNull, z.string().trim().toLowerCase().min(1).max(253).nullable().optional()),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    security: z.enum(SMTP_SECURITY_MODES).nullable().optional(),
    username: z.preprocess(blankToNull, z.string().trim().min(1).max(256).nullable().optional()),
    // A string to test with, null to test without authentication. Omitted:
    // the saved password — only for the saved provider, host, port, security and user.
    password: z.preprocess(blankToUndefined, z.string().min(1).max(512).nullable().optional()),
    from: z.preprocess(blankToNull, z.string().trim().min(3).max(320).nullable().optional()),
  })
  .strict();

export type AdminMailTestInput = z.infer<typeof AdminMailTestSchema>;
export type AdminMailTestResult = { ok: true; outcome: MailOutcome } | AdminRefusal;

/**
 * "Send a test email" (§5): connect, authenticate and send the `test`
 * template. Values left out fall back to the saved ones — but the saved (or
 * environment) password ONLY when the provider, host, port, security and
 * user are the saved ones: testing another connection needs `password`
 * (400 `password_required` when that connection authenticates). An override
 * of an environment-locked field is 409 `locked_by_env`. The result is
 * recorded as the last test, with the fingerprint of the configuration it
 * tested, only when the test ran against the SAVED configuration.
 */
export async function testMailConfiguration(input: AdminMailTestInput, adminEmail: string | null): Promise<AdminMailTestResult> {
  const current = await resolveMailSettings({ fresh: true });
  const { to, ...overrides } = input;
  const locked = current.locked;
  const lockedFields = ['provider', 'host', 'port', 'security', 'username', 'from'] as const;
  for (const field of lockedFields) {
    const value = overrides[field];
    if (locked[field] && value !== undefined && (value ?? null) !== (current[field] ?? null)) return lockedByEnv(field);
  }
  if (locked.password && overrides.password !== undefined) return lockedByEnv('password');

  const unsaved = Object.values(overrides).some((value) => value !== undefined);
  const prepared = prepareTest(current, overrides, to ?? adminEmail);
  if (!prepared.ok) return prepared.refusal ?? { ok: true, outcome: prepared.outcome };
  // The configuration the result describes — captured before the test, so a
  // save that lands meanwhile can never inherit it.
  const fingerprint = unsaved ? null : mailTestFingerprint(connectionOf(current));
  const outcome = await runTest(prepared.config, prepared.from, prepared.to);
  if (!unsaved && current.loaded) {
    try {
      await recordInstanceMailTest(getDb(), { result: outcome.result, fingerprint });
      invalidateMailSettingsCache();
    } catch (error) {
      console.error('[admin/mail] could not record the test result', JSON.stringify((error as Error).message));
    }
  }
  return { ok: true, outcome };
}

type PreparedTest =
  | { ok: true; config: SmtpConfig; from: string; to: string }
  | { ok: false; outcome: MailOutcome; refusal?: undefined }
  | { ok: false; refusal: AdminRefusal; outcome?: undefined };

function prepareTest(current: ResolvedMailSettings, overrides: Omit<AdminMailTestInput, 'to'>, recipient: string | null): PreparedTest {
  const provider = overrides.provider ?? current.provider;
  if (provider === 'none') return { ok: false, outcome: { result: 'not_configured' } };
  const preset = getMailProvider(provider);
  const providerChanged = provider !== current.provider;
  const region = overrides.region !== undefined ? overrides.region : providerChanged ? null : current.region;
  const host =
    (overrides.host !== undefined ? overrides.host : providerChanged ? null : current.host) ?? (preset ? presetHost(preset, region) : null);
  if (!host) return { ok: false, outcome: { result: 'not_configured', detail: 'missing_host' } };
  const port = (overrides.port !== undefined ? overrides.port : providerChanged ? null : current.port) ?? preset?.ports[0]?.port ?? null;
  if (port === null) return { ok: false, outcome: { result: 'not_configured', detail: 'missing_port' } };
  const security =
    (overrides.security !== undefined ? overrides.security : providerChanged ? null : current.security) ??
    preset?.ports.find((p) => p.port === port)?.security ??
    defaultSecurityForPort(port);
  const username = overrides.username !== undefined ? overrides.username : current.username;

  const connectionChanged =
    providerChanged ||
    host.toLowerCase() !== (current.host ?? '').toLowerCase() ||
    port !== current.port ||
    security !== current.security ||
    (username ?? null) !== (current.username ?? null);
  let password: string | null;
  if (overrides.password !== undefined) {
    password = overrides.password;
  } else if (connectionChanged) {
    // Never the saved secret for a connection the admin just typed.
    if (username) return { ok: false, refusal: passwordRequired };
    password = null;
  } else if (current.passwordState === 'undecryptable') {
    return { ok: false, outcome: { result: 'not_configured', detail: 'password_undecryptable' } };
  } else {
    password = current.password;
  }

  const from = parseFromAddress(overrides.from !== undefined ? overrides.from : current.from);
  if (!from) return { ok: false, outcome: { result: 'not_configured', detail: 'missing_from' } };
  const to = recipient ? EmailAddressSchema.safeParse(recipient) : null;
  if (!to?.success) return { ok: false, outcome: { result: 'not_configured', detail: 'missing_recipient' } };
  return { ok: true, config: { provider, host, port, security, username, password }, from: from.header, to: to.data };
}

async function runTest(config: SmtpConfig, from: string, to: string): Promise<MailOutcome> {
  const built = await createSmtpTransport(config, smtpTargetContext(), { pooled: false });
  if (!built.ok) return built.outcome;
  try {
    const verified = await built.transport.verify();
    if (!verified.ok) {
      const { ok: _ok, ...outcome } = verified;
      return outcome;
    }
    await countSend();
    const sent = await deliverMail(built.transport, {
      from,
      to,
      template: 'test',
      locale: mailLocale(null),
      vars: { instanceName: await instanceDisplayName() },
    });
    if (!sent.ok) return sent.outcome;
    await recordMailSuccess();
    return { result: 'ok' };
  } finally {
    built.transport.close();
  }
}
