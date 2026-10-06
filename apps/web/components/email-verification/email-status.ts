/**
 * Email verification, browser side: the user-facing shapes of
 * docs/EMAIL.md §4.3 and the small pure rules the banner, the code entry
 * and every restricted control share.
 *
 * The server owns verification and enforcement (`requireVerifiedEmail`
 * answers 403 `email_unverified`). The UI only reflects it: it disables a
 * control up front when the status says restricted, and explains a refusal
 * in the viewer's language when it gets one anyway.
 */

export type EmailVerificationMode = 'off' | 'optional' | 'required';

/** `GET /api/auth/email/status`. */
export interface EmailStatus {
  email: string | null;
  verified: boolean;
  mode: EmailVerificationMode;
  /** True only in `required` mode, for an account the rules of §4.2 lock. */
  restricted: boolean;
  /** The new address an email change is waiting to confirm. */
  pendingChange: string | null;
  /** When "Resend" opens again (ISO), or null when it is open now. */
  resendAvailableAt: string | null;
  /** Whether the instance has a mail transport at all. */
  mailConfigured: boolean;
}

/** What a restricted account cannot do (§4.2), each with its own sentence. */
export type RestrictedAction =
  | 'message'
  | 'dm'
  | 'voice'
  | 'createServer'
  | 'createChannel'
  | 'createInvite'
  | 'upload'
  | 'createBot'
  | 'createWebhook'
  | 'publish'
  /** The note on a join request (asking without one still works). */
  | 'joinRequestNote';

export const RESTRICTED_ACTION_KEYS: Record<RestrictedAction, string> = {
  message: 'emailVerification.restricted.action.message',
  dm: 'emailVerification.restricted.action.dm',
  voice: 'emailVerification.restricted.action.voice',
  createServer: 'emailVerification.restricted.action.createServer',
  createChannel: 'emailVerification.restricted.action.createChannel',
  createInvite: 'emailVerification.restricted.action.createInvite',
  upload: 'emailVerification.restricted.action.upload',
  createBot: 'emailVerification.restricted.action.createBot',
  createWebhook: 'emailVerification.restricted.action.createWebhook',
  publish: 'emailVerification.restricted.action.publish',
  joinRequestNote: 'emailVerification.restricted.action.joinRequestNote',
};

/** The refusal code of `requireVerifiedEmail`. */
export const EMAIL_UNVERIFIED = 'email_unverified';

export const CODE_LENGTH = 6;

const MODES: readonly EmailVerificationMode[] = ['off', 'optional', 'required'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * Read a status answer defensively. Anything that is not that shape is
 * `null`, and the UI then shows nothing rather than guessing.
 */
export function parseEmailStatus(raw: unknown): EmailStatus | null {
  if (!isRecord(raw) || typeof raw.verified !== 'boolean') return null;
  const mode = typeof raw.mode === 'string' && MODES.includes(raw.mode as EmailVerificationMode)
    ? (raw.mode as EmailVerificationMode)
    : 'off';
  return {
    email: stringOrNull(raw.email),
    verified: raw.verified,
    mode,
    restricted: raw.restricted === true,
    pendingChange: stringOrNull(raw.pendingChange),
    resendAvailableAt: isoOrNull(raw.resendAvailableAt),
    mailConfigured: raw.mailConfigured === true,
  };
}

/**
 * Whether the banner and its code entry belong on screen: an account with
 * an address that is not verified, on an instance that asks for it.
 * Guests have no address and never see it.
 */
export function needsVerification(status: EmailStatus | null): boolean {
  return Boolean(status && status.email && !status.verified && status.mode !== 'off');
}

/** Whether the server will refuse the actions of §4.2 for this account. */
export function isRestricted(status: EmailStatus | null): boolean {
  return Boolean(status && status.restricted && !status.verified);
}

/** Whether a response is `requireVerifiedEmail`'s refusal. */
export function isEmailUnverified(httpStatus: number, body: unknown): boolean {
  return httpStatus === 403 && isRecord(body) && body.error === EMAIL_UNVERIFIED;
}

/** The same check on a Response, reading a clone so the caller keeps the body. */
export async function readEmailUnverified(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const body: unknown = await response.clone().json().catch(() => null);
  return isEmailUnverified(response.status, body);
}

/** Digits only, at most six — pasting "123 456" or "123-456" works. */
export function normalizeCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

/** Whole seconds until an instant, never negative. */
export function secondsUntil(iso: string | null, now: number = Date.now()): number {
  if (!iso) return 0;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** "0:42", "12:05" — a countdown, the same in every language. */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

/** A retry instant from a 429's `retryAfter` (seconds). */
export function retryInstant(retryAfterSeconds: unknown, now: number = Date.now()): string | null {
  const seconds = Number(retryAfterSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(now + Math.ceil(seconds) * 1000).toISOString();
}

export interface Notice {
  key: string;
  params?: Record<string, string | number>;
}

/**
 * Why a code (or a link) was not accepted: `POST /api/auth/email/verify`
 * and `/change/confirm` answer 400 with one of these codes.
 */
export function codeRefusalNotice(httpStatus: number, body: unknown): Notice {
  const code = isRecord(body) && typeof body.error === 'string' ? body.error : '';
  if (httpStatus === 429) return { key: 'emailVerification.error.rateLimited' };
  if (code === 'invalid_code') return { key: 'emailVerification.code.error.invalid' };
  if (code === 'expired') return { key: 'emailVerification.code.error.expired' };
  if (code === 'too_many_attempts') return { key: 'emailVerification.code.error.tooMany' };
  if (code === 'invalid_token') return { key: 'emailVerification.code.error.invalidToken' };
  if (code === 'email_taken') return { key: 'emailVerification.change.error.taken' };
  if (code === 'already_verified') return { key: 'emailVerification.code.error.alreadyVerified' };
  return { key: 'emailVerification.code.error.generic' };
}

/**
 * Why an email could not be sent (`verify/send`, `change`): rate limits,
 * no transport, the instance's daily limit.
 */
export function sendRefusalNotice(httpStatus: number, body: unknown): Notice {
  const code = isRecord(body) && typeof body.error === 'string' ? body.error : '';
  if (httpStatus === 429 || code === 'rate_limited') return { key: 'emailVerification.error.rateLimited' };
  if (code === 'mail_quota') return { key: 'emailVerification.error.mailQuota' };
  if (httpStatus === 503 || code === 'mail_unavailable') return { key: 'emailVerification.error.mailUnavailable' };
  if (code === 'already_verified') return { key: 'emailVerification.code.error.alreadyVerified' };
  return { key: 'emailVerification.error.sendFailed' };
}
