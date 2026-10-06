/**
 * Email (docs/EMAIL.md) — the shared vocabulary: provider ids, transport
 * security, verification modes and scope, the test results and their
 * detail codes, the templates and the actions an unverified account may
 * be refused. Client-safe (no Node imports): the admin screen and the UI
 * may import the types and constants from here.
 */
import { z } from 'zod';

export const MAIL_PROVIDER_IDS = ['ses', 'scaleway', 'brevo', 'smtp2go', 'resend', 'mailjet', 'mailgun', 'gmail', 'custom', 'mailpit'] as const;
export type MailProviderId = (typeof MAIL_PROVIDER_IDS)[number];
/** What `instance_settings.mail_provider` holds: a registry id, or `none` (no transport). */
export type MailProviderSetting = MailProviderId | 'none';

export const SMTP_SECURITY_MODES = ['tls', 'starttls', 'none'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY_MODES)[number];

export const EMAIL_VERIFICATION_MODES = ['off', 'optional', 'required'] as const;
export type EmailVerificationMode = (typeof EMAIL_VERIFICATION_MODES)[number];

export interface EmailVerificationScope {
  open_register: boolean;
  invite_register: boolean;
}

export const DEFAULT_EMAIL_VERIFICATION_SCOPE: Readonly<EmailVerificationScope> = Object.freeze({
  open_register: true,
  invite_register: false,
});

export interface DisposableOverrides {
  allow: string[];
  block: string[];
}

/** §3.4 — the SMTP ports an admin may choose. 1025 (mailpit) only for development. */
export const ALLOWED_SMTP_PORTS: readonly number[] = [25, 465, 587, 2465, 2525, 2587];
export const DEVELOPMENT_SMTP_PORT = 1025;

/** `POST /api/admin/mail/test` → `result` (§5). */
export const MAIL_TEST_RESULTS = [
  'ok',
  'timeout',
  'tls',
  'auth',
  'sender_rejected',
  'recipient_rejected',
  'connection',
  'host_not_allowed',
  'not_configured',
] as const;
export type MailTestResult = (typeof MAIL_TEST_RESULTS)[number];

/**
 * `detail` of a test result — a CODE the admin screen translates, never
 * free text (§5). See docs/EMAIL.md §5 for the table.
 */
export const MAIL_TEST_DETAILS = [
  // timeout
  'try_port_2525',
  'try_port_2587',
  // tls
  'use_starttls',
  'use_tls',
  'tls_certificate',
  // auth
  'check_credentials',
  'gmail_app_password',
  // sender_rejected
  'sender_domain',
  'message_rejected',
  // connection
  'host_not_found',
  'connection_refused',
  // host_not_allowed
  'port_not_allowed',
  'address_not_allowed',
  'security_not_allowed',
  'invalid_host',
  // not_configured
  'missing_host',
  'missing_port',
  'missing_from',
  'missing_recipient',
  'password_undecryptable',
] as const;
export type MailTestDetail = (typeof MAIL_TEST_DETAILS)[number];

/** The classified outcome of a send or a connection test. */
export interface MailOutcome {
  result: MailTestResult;
  detail?: MailTestDetail;
}

export const MAIL_TEMPLATES = ['verify', 'change-confirm', 'change-notice', 'reset', 'test'] as const;
export type MailTemplate = (typeof MAIL_TEMPLATES)[number];

/**
 * What a restricted (unverified, `required` mode) account is refused
 * (§4.2). `requireVerifiedEmail(user, action)` takes one of these.
 */
export const VERIFIED_ACTIONS = [
  'message',
  'dm',
  'reaction',
  'voice',
  'server_create',
  'channel_create',
  'invite_create',
  'upload',
  'bot_create',
  'bot_token',
  'webhook',
  'plugin_publish',
  'directory_listing',
  'join_request',
] as const;
export type VerifiedAction = (typeof VERIFIED_ACTIONS)[number];

/** The user-side API error codes (§4.3). */
export type EmailApiError =
  | 'email_unverified'
  | 'already_verified'
  | 'rate_limited'
  | 'mail_unavailable'
  | 'mail_quota'
  | 'invalid_code'
  | 'expired'
  | 'too_many_attempts'
  | 'invalid_token'
  | 'invalid_password'
  | 'invalid_email'
  | 'email_taken'
  | 'disposable_email'
  | 'no_email';

/** A 6-digit code (§4.1). */
export const EmailCodeSchema = z.string().trim().regex(/^\d{6}$/);
/** The link token: 32 random bytes, base64url (43 characters). */
export const EmailLinkTokenSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{43}$/);
/** An address as everything else in the app stores it: trimmed, lower case, at most 254 characters. */
export const EmailAddressSchema = z.string().trim().toLowerCase().email().max(254);

export function isMailProviderId(value: unknown): value is MailProviderId {
  return typeof value === 'string' && (MAIL_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isSmtpSecurity(value: unknown): value is SmtpSecurity {
  return typeof value === 'string' && (SMTP_SECURITY_MODES as readonly string[]).includes(value);
}

export function isEmailVerificationMode(value: unknown): value is EmailVerificationMode {
  return typeof value === 'string' && (EMAIL_VERIFICATION_MODES as readonly string[]).includes(value);
}

/** Stored scope → a complete one: missing or invalid keys get their defaults. */
export function parseEmailVerificationScope(raw: unknown): EmailVerificationScope {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    open_register: typeof source.open_register === 'boolean' ? source.open_register : DEFAULT_EMAIL_VERIFICATION_SCOPE.open_register,
    invite_register:
      typeof source.invite_register === 'boolean' ? source.invite_register : DEFAULT_EMAIL_VERIFICATION_SCOPE.invite_register,
  };
}

/** Stored overrides → two clean lists of lower-case domains. */
export function parseDisposableOverrides(raw: unknown): DisposableOverrides {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const list = (value: unknown) =>
    Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim().toLowerCase()).filter(Boolean))]
      : [];
  return { allow: list(source.allow), block: list(source.block) };
}

/**
 * How recent a passing test of the saved mail settings must be to switch
 * verification to `required` (docs/EMAIL.md §4.2). Shared by the admin API
 * and the admin screen.
 */
export const REQUIRED_TEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
