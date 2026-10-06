/**
 * The admin side of email: the `GET`/`PUT /api/admin/mail` and
 * `POST /api/admin/mail/test` shapes of docs/EMAIL.md §5, and the pure
 * logic the Email settings card runs on them. The provider presets come
 * from the registry (`lib/mail/providers.ts`), passed in by the page.
 */
import type { MailProviderPreset } from '@/lib/mail/providers';
import type { EmailVerificationMode, MailTestDetail, MailTestResult, SmtpSecurity } from '@/lib/mail/types';
import { REQUIRED_TEST_MAX_AGE_MS } from '@/lib/mail/types';

export type { MailProviderPreset, MailTestDetail, MailTestResult, SmtpSecurity, EmailVerificationMode };

export interface EmailVerificationScope {
  open_register: boolean;
  invite_register: boolean;
}

/** `GET /api/admin/mail` — and what `PUT` answers with. */
export interface AdminMailSettings {
  provider: string;
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
  verification: {
    mode: EmailVerificationMode;
    scope: EmailVerificationScope;
    enforcedSince: string | null;
    existingDeadline: string | null;
  };
  disposable: { block: boolean; allow: string[]; blockExtra: string[] };
  locked: Record<LockableField, boolean>;
}

export type LockableField = 'provider' | 'host' | 'port' | 'security' | 'username' | 'password' | 'from' | 'verification';

/** The environment variables that lock each field (§3.2). */
export const LOCK_ENV: Record<LockableField, string> = {
  provider: 'LOBBYFORGE_MAIL_PROVIDER',
  host: 'LOBBYFORGE_SMTP_HOST',
  port: 'LOBBYFORGE_SMTP_PORT',
  security: 'LOBBYFORGE_SMTP_SECURITY',
  username: 'LOBBYFORGE_SMTP_USER',
  password: 'LOBBYFORGE_SMTP_PASSWORD',
  from: 'LOBBYFORGE_MAIL_FROM',
  verification: 'LOBBYFORGE_EMAIL_VERIFICATION',
};

/** What the card edits. Number fields stay text while typed; the password is a `SecretAction`. */
export interface MailDraft {
  provider: string;
  region: string | null;
  host: string;
  port: string;
  security: SmtpSecurity;
  username: string;
  from: string;
  dailyLimit: string;
  mode: EmailVerificationMode;
  scope: EmailVerificationScope;
  /** `YYYY-MM-DD` (a date input's value) or empty. */
  existingDeadline: string;
  disposableBlock: boolean;
  /** One domain per line. */
  allow: string;
  blockExtra: string;
}

/** The password is write-only: keep the saved one, replace it, or clear it. */
export type SecretAction = { kind: 'keep' } | { kind: 'replace'; value: string } | { kind: 'clear' };

export interface MailTestOutcome {
  result: MailTestResult;
  detail: MailTestDetail | null;
}

const RESULTS: readonly MailTestResult[] = [
  'ok',
  'timeout',
  'tls',
  'auth',
  'sender_rejected',
  'recipient_rejected',
  'connection',
  'host_not_allowed',
  'not_configured',
];
const MODES: readonly EmailVerificationMode[] = ['off', 'optional', 'required'];
const SECURITIES: readonly SmtpSecurity[] = ['tls', 'starttls', 'none'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function iso(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function domains(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
}

/** Read the admin API's answer, filling defaults; `null` when it is not that shape at all. */
export function parseAdminMailSettings(raw: unknown): AdminMailSettings | null {
  if (!isRecord(raw) || typeof raw.provider !== 'string') return null;
  const verification = isRecord(raw.verification) ? raw.verification : {};
  const scope = isRecord(verification.scope) ? verification.scope : {};
  const lastTest = isRecord(raw.lastTest) ? raw.lastTest : {};
  const disposable = isRecord(raw.disposable) ? raw.disposable : {};
  const locked = isRecord(raw.locked) ? raw.locked : {};
  return {
    provider: raw.provider,
    region: str(raw.region),
    host: str(raw.host),
    port: int(raw.port),
    security: oneOf(raw.security, SECURITIES),
    username: str(raw.username),
    passwordSet: raw.passwordSet === true,
    passwordHint: str(raw.passwordHint),
    from: str(raw.from),
    dailyLimit: int(raw.dailyLimit),
    sentToday: int(raw.sentToday) ?? 0,
    lastTest: { at: iso(lastTest.at), result: oneOf(lastTest.result, RESULTS) },
    verification: {
      mode: oneOf(verification.mode, MODES) ?? 'off',
      scope: {
        open_register: typeof scope.open_register === 'boolean' ? scope.open_register : true,
        invite_register: scope.invite_register === true,
      },
      enforcedSince: iso(verification.enforcedSince),
      existingDeadline: iso(verification.existingDeadline),
    },
    disposable: {
      block: disposable.block === true,
      allow: domains(disposable.allow),
      blockExtra: domains(disposable.blockExtra),
    },
    locked: {
      provider: locked.provider === true,
      host: locked.host === true,
      port: locked.port === true,
      security: locked.security === true,
      username: locked.username === true,
      password: locked.password === true,
      from: locked.from === true,
      verification: locked.verification === true,
    },
  };
}

/** A date input's `YYYY-MM-DD` for an instant, in the admin's own time zone. */
export function isoToDateInput(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The END of that day in the admin's time zone, as an instant: "by 12 March" includes 12 March. */
export function dateInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 0);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Text area → clean list: one domain per line (commas and spaces work too), lower case, no repeats. */
export function splitDomains(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\s,;]+/)) {
    const domain = part.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
    if (domain) seen.add(domain);
  }
  return [...seen];
}

/** Entries of a domain list that cannot be a domain (shown before saving). */
export function invalidDomains(list: string[]): string[] {
  const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
  return list.filter((domain) => !DOMAIN.test(domain));
}

export function draftFrom(settings: AdminMailSettings): MailDraft {
  return {
    provider: settings.provider,
    region: settings.region,
    host: settings.host ?? '',
    port: settings.port === null ? '' : String(settings.port),
    security: settings.security ?? 'starttls',
    username: settings.username ?? '',
    from: settings.from ?? '',
    dailyLimit: settings.dailyLimit === null ? '' : String(settings.dailyLimit),
    mode: settings.verification.mode,
    scope: { ...settings.verification.scope },
    existingDeadline: isoToDateInput(settings.verification.existingDeadline),
    disposableBlock: settings.disposable.block,
    allow: settings.disposable.allow.join('\n'),
    blockExtra: settings.disposable.blockExtra.join('\n'),
  };
}

/** The host a preset implies: its fixed host, or the chosen (else first) region's. */
export function hostForPreset(preset: MailProviderPreset, region: string | null): string {
  if (preset.host) return preset.host;
  const regions = preset.regions ?? [];
  return (regions.find((r) => r.id === region) ?? regions[0])?.host ?? '';
}

/**
 * Choosing a preset fills host, port and security (its recommended port)
 * and picks its first region. Custom keeps whatever was typed.
 */
export function applyPreset(draft: MailDraft, preset: MailProviderPreset | null, providerId: string): MailDraft {
  if (!preset) return { ...draft, provider: providerId, region: null };
  const region = preset.regions?.length ? (preset.regions.find((r) => r.id === draft.region) ?? preset.regions[0])!.id : null;
  const recommended = preset.ports[0];
  if (preset.tier === 'custom') {
    return {
      ...draft,
      provider: preset.id,
      region: null,
      // A host from another preset is not "custom" input: start empty.
      host: draft.provider === 'custom' || draft.provider === 'none' ? draft.host : '',
      port: draft.port || (recommended ? String(recommended.port) : ''),
      security: recommended?.security ?? draft.security,
    };
  }
  return {
    ...draft,
    provider: preset.id,
    region,
    host: hostForPreset(preset, region),
    port: recommended ? String(recommended.port) : draft.port,
    security: recommended?.security ?? draft.security,
  };
}

/** A port picked from a preset's list brings its security with it. */
export function applyPort(draft: MailDraft, preset: MailProviderPreset | null, port: string): MailDraft {
  const match = preset?.ports.find((option) => String(option.port) === port);
  return { ...draft, port, security: match?.security ?? draft.security };
}

function normalized(draft: MailDraft) {
  return {
    provider: draft.provider,
    region: draft.region,
    host: draft.host.trim().toLowerCase(),
    port: draft.port.trim(),
    security: draft.security,
    username: draft.username.trim(),
    from: draft.from.trim(),
    dailyLimit: draft.dailyLimit.trim(),
    mode: draft.mode,
    scope: draft.scope,
    existingDeadline: draft.existingDeadline,
    disposableBlock: draft.disposableBlock,
    allow: splitDomains(draft.allow),
    blockExtra: splitDomains(draft.blockExtra),
  };
}

/** Whether anything would change on save. */
export function isDirty(saved: AdminMailSettings, draft: MailDraft, secret: SecretAction): boolean {
  if (secret.kind === 'clear' || (secret.kind === 'replace' && secret.value !== '')) return true;
  return JSON.stringify(normalized(draftFrom(saved))) !== JSON.stringify(normalized(draft));
}

/** Whether the connection (what a test checks) differs from the saved one. */
export function isConnectionDirty(saved: AdminMailSettings, draft: MailDraft, secret: SecretAction): boolean {
  if (secret.kind === 'clear' || (secret.kind === 'replace' && secret.value !== '')) return true;
  const a = normalized(draftFrom(saved));
  const b = normalized(draft);
  return (
    a.provider !== b.provider ||
    a.region !== b.region ||
    a.host !== b.host ||
    a.port !== b.port ||
    a.security !== b.security ||
    a.username !== b.username ||
    a.from !== b.from
  );
}

/**
 * `required` locks new accounts out of chatting until they verify, so it
 * needs mail that works: a configured transport whose last test with the
 * SAVED settings passed (§4.2; the server checks the same). An unsaved
 * connection change means that test no longer describes what would run.
 */
export function requiredBlockedReason(
  saved: AdminMailSettings,
  draft: MailDraft,
  secret: SecretAction,
  now: number = Date.now()
): 'none' | 'noTransport' | 'noPassingTest' | 'staleTest' | 'unsavedConnection' {
  if (saved.verification.mode === 'required') return 'none';
  if (draft.provider === 'none') return 'noTransport';
  if (isConnectionDirty(saved, draft, secret)) return 'unsavedConnection';
  if (saved.provider === 'none') return 'noTransport';
  if (saved.lastTest.result !== 'ok') return 'noPassingTest';
  // The server also wants the passing test to be recent (credentials can be
  // revoked at the provider since).
  const testedAt = saved.lastTest.at ? Date.parse(saved.lastTest.at) : NaN;
  if (!Number.isFinite(testedAt) || now - testedAt > REQUIRED_TEST_MAX_AGE_MS) return 'staleTest';
  return 'none';
}

/**
 * While verification is (or is about to be) `required`, mail has to keep
 * working: turning the transport off, or clearing the password of one that
 * signs in, would lock every new member out with no way to verify. The
 * server refuses it (409 `transport_required`); the card says so first.
 */
export function transportLockedByRequired(draft: MailDraft): boolean {
  return draft.mode === 'required';
}

/** The draft would leave `required` without a working transport. */
export function breaksRequiredTransport(saved: AdminMailSettings, draft: MailDraft, secret: SecretAction): boolean {
  if (!transportLockedByRequired(draft)) return false;
  if (draft.provider === 'none') return true;
  return secret.kind === 'clear' && saved.passwordSet && !saved.locked.password;
}

/**
 * The saved password is only reused for the same server: changing the
 * provider, the host or the user name means typing it again (the server
 * requires it on save and will not test with the stored one). Not for "no
 * email", Mailpit (no sign-in), a server without a user name, or a
 * password the environment sets.
 */
export function passwordMustBeReentered(saved: AdminMailSettings, draft: MailDraft): boolean {
  if (saved.locked.password || draft.provider === 'none' || draft.provider === 'mailpit') return false;
  if (!draft.username.trim() && !saved.locked.username) return false;
  const savedProvider = saved.provider;
  const savedHost = (saved.host ?? '').trim().toLowerCase();
  const savedUser = (saved.username ?? '').trim();
  const hostChanged = !saved.locked.host && draft.host.trim().toLowerCase() !== savedHost;
  const userChanged = !saved.locked.username && draft.username.trim() !== savedUser;
  const providerChanged = !saved.locked.provider && draft.provider !== savedProvider;
  return providerChanged || hostChanged || userChanged;
}

/** A required re-entry the admin has not done yet. */
export function passwordMissing(saved: AdminMailSettings, draft: MailDraft, secret: SecretAction): boolean {
  return passwordMustBeReentered(saved, draft) && !(secret.kind === 'replace' && secret.value !== '');
}

/**
 * Turning `required` back on: `enforcedSince` is only set the first time,
 * so every account created since then — not only new ones — is restricted
 * until it verifies. The card warns with that date.
 */
export function reenablingRequiredSince(saved: AdminMailSettings, draft: MailDraft): string | null {
  if (draft.mode !== 'required' || saved.verification.mode === 'required') return null;
  return saved.verification.enforcedSince;
}

function portNumber(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== '' && Number.isInteger(value) ? value : null;
}

/** What the form would save, before sending (the server checks again). */
export function draftIssues(draft: MailDraft): Array<'host' | 'port' | 'from' | 'dailyLimit' | 'allow' | 'blockExtra'> {
  const issues: Array<'host' | 'port' | 'from' | 'dailyLimit' | 'allow' | 'blockExtra'> = [];
  if (draft.provider !== 'none') {
    if (!draft.host.trim()) issues.push('host');
    const port = portNumber(draft.port);
    if (port === null || port < 1 || port > 65535) issues.push('port');
    if (!draft.from.trim() || !draft.from.includes('@')) issues.push('from');
  }
  if (draft.dailyLimit.trim()) {
    const limit = portNumber(draft.dailyLimit);
    if (limit === null || limit < 1) issues.push('dailyLimit');
  }
  if (invalidDomains(splitDomains(draft.allow)).length > 0) issues.push('allow');
  if (invalidDomains(splitDomains(draft.blockExtra)).length > 0) issues.push('blockExtra');
  return issues;
}

/**
 * The `PUT` body: the GET shape without its read-only fields. A locked
 * field goes back with its saved (environment) value — unchanged, so the
 * server keeps it; the password is a string to set, `null` to clear, or
 * absent to keep.
 */
export function buildPutBody(saved: AdminMailSettings, draft: MailDraft, secret: SecretAction): Record<string, unknown> {
  const off = draft.provider === 'none';
  const body: Record<string, unknown> = {
    provider: saved.locked.provider ? saved.provider : draft.provider,
    region: off ? null : draft.region,
    host: saved.locked.host ? saved.host : off ? null : draft.host.trim() || null,
    port: saved.locked.port ? saved.port : off ? null : portNumber(draft.port),
    security: saved.locked.security ? saved.security : off ? null : draft.security,
    username: saved.locked.username ? saved.username : off ? null : draft.username.trim() || null,
    from: saved.locked.from ? saved.from : draft.from.trim() || null,
    dailyLimit: draft.dailyLimit.trim() ? portNumber(draft.dailyLimit) : null,
    verification: {
      mode: saved.locked.verification ? saved.verification.mode : draft.mode,
      scope: draft.scope,
      existingDeadline: dateInputToIso(draft.existingDeadline),
    },
    disposable: {
      block: draft.disposableBlock,
      allow: splitDomains(draft.allow),
      blockExtra: splitDomains(draft.blockExtra),
    },
  };
  if (!saved.locked.password) {
    if (secret.kind === 'clear') body.password = null;
    else if (secret.kind === 'replace' && secret.value !== '') body.password = secret.value;
  }
  return body;
}

/**
 * The test call: the recipient, plus the unsaved connection where there is
 * one. With no overrides it runs against the SAVED settings — the only
 * test the server records as "last test" (§5).
 */
export function buildTestBody(
  saved: AdminMailSettings,
  draft: MailDraft,
  secret: SecretAction,
  to: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (to.trim()) body.to = to.trim();
  if (!isConnectionDirty(saved, draft, secret)) return body;
  const put = buildPutBody(saved, draft, secret);
  for (const key of ['provider', 'region', 'host', 'port', 'security', 'username', 'from', 'password'] as const) {
    if (key in put) body[key] = put[key];
  }
  return body;
}

export function parseTestOutcome(raw: unknown): MailTestOutcome | null {
  if (!isRecord(raw)) return null;
  const result = oneOf(raw.result, RESULTS);
  if (!result) return null;
  return { result, detail: typeof raw.detail === 'string' && raw.detail ? (raw.detail as MailTestDetail) : null };
}

export interface ProviderGroups {
  professional: MailProviderPreset[];
  free: MailProviderPreset[];
  custom: MailProviderPreset[];
  development: MailProviderPreset[];
}

export function groupProviders(presets: readonly MailProviderPreset[]): ProviderGroups {
  const groups: ProviderGroups = { professional: [], free: [], custom: [], development: [] };
  for (const preset of presets) groups[preset.tier].push(preset);
  return groups;
}
