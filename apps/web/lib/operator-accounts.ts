/**
 * Account recovery by the server operator: the logic behind
 * `lfctl user reset-password` and `lfctl user list-admins`
 * (docs/GUEST_AUTH.md "Account recovery by the server operator").
 *
 * It runs inside the web container (`scripts/operator-user.mjs`, which
 * loads this file with Node's type stripping), so it is the app's own code
 * end to end: the password hash (`lib/password`), the sign-up policy
 * (`lib/password-strength`) and the password-reset machinery — every
 * session revoked, desktop handoff codes dropped, the sign-in lock for the
 * address cleared. Device cookies are bound to the password hash, so the
 * new hash voids them by itself.
 *
 * Keep the imports here (and in the modules they pull in) to what Node can
 * strip: type-only imports marked `type`, no enums or namespaces. The
 * lfctl-user-recovery test loads this file the way the container does.
 */
import {
  listInstanceAdminAccounts,
  resetUserPasswordAsOperator,
  type OperatorAdminAccount,
} from '@lobbyforge/db';
import { clearAccountAttempts } from '@/lib/auth-throttle';
import { getDb } from '@/lib/db';
import { revokeDesktopHandoffCodes } from '@/lib/desktop-handoff-codes';
import { hashPassword } from '@/lib/password';
import { MIN_PASSWORD_LENGTH } from '@/lib/password-strength';
import { revokeOtherSessions } from '@/lib/session-tracker';

export { MIN_PASSWORD_LENGTH };
/** The sign-up policy's upper bound (`/api/auth/register`: 12–128 characters). */
export const MAX_PASSWORD_LENGTH = 128;
const MAX_EMAIL_LENGTH = 320;

export type OperatorRequest =
  | { action: 'list-admins' }
  | { action: 'reset-password'; email: string; password: string };

export type OperatorError =
  | 'invalid_request'
  | 'invalid_email'
  | 'weak_password'
  | 'password_too_long'
  | 'unknown_email'
  | 'deleted_account'
  | 'guest_account';

export type OperatorResponse =
  | { ok: true; action: 'list-admins'; accounts: OperatorAdminAccount[] }
  | {
      ok: true;
      action: 'reset-password';
      email: string;
      displayName: string;
      /** Sessions signed out; null when the revocation failed (see `warning`). */
      sessionsRevoked: number | null;
      warning?: 'sessions_not_revoked';
    }
  | { ok: false; error: OperatorError; minLength?: number; maxLength?: number };

/** The sign-up rule (`/api/auth/register`): 12–128 UTF-16 code units, as zod counts them. */
export function passwordPolicyError(password: string): 'weak_password' | 'password_too_long' | null {
  if (password.length < MIN_PASSWORD_LENGTH) return 'weak_password';
  if (password.length > MAX_PASSWORD_LENGTH) return 'password_too_long';
  return null;
}

function isEmailShaped(value: string): boolean {
  return value.length <= MAX_EMAIL_LENGTH && /^[^\s@]+@[^\s@]+$/.test(value);
}

/** The request lfctl writes to the script's stdin; null when it is not one. */
export function parseOperatorRequest(raw: unknown): OperatorRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (input.action === 'list-admins') return { action: 'list-admins' };
  if (input.action === 'reset-password' && typeof input.email === 'string' && typeof input.password === 'string') {
    return { action: 'reset-password', email: input.email, password: input.password };
  }
  return null;
}

async function resetPassword(email: string, password: string): Promise<OperatorResponse> {
  const normalised = email.trim().toLowerCase();
  if (!isEmailShaped(normalised)) return { ok: false, error: 'invalid_email' };
  const policy = passwordPolicyError(password);
  if (policy) {
    return { ok: false, error: policy, minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH };
  }

  const result = await resetUserPasswordAsOperator(getDb(), {
    email: normalised,
    newPasswordHash: await hashPassword(password),
  });
  if (!result.ok) {
    const error: Record<typeof result.reason, OperatorError> = {
      not_found: 'unknown_email',
      deleted: 'deleted_account',
      guest: 'guest_account',
    };
    return { ok: false, error: error[result.reason] };
  }

  // What POST /api/auth/password/reset does after it sets a password.
  await revokeDesktopHandoffCodes(result.userId).catch((err: unknown) => {
    console.error('[operator] failed to clear desktop handoff codes', JSON.stringify((err as Error).message));
  });
  await clearAccountAttempts({ scope: 'sign-in', email: result.email }).catch(() => undefined);
  let sessionsRevoked: number | null;
  try {
    // '' matches no session: all of them go.
    sessionsRevoked = await revokeOtherSessions(result.userId, '');
  } catch (err) {
    console.error('[operator] failed to revoke sessions', JSON.stringify((err as Error).message));
    return {
      ok: true,
      action: 'reset-password',
      email: result.email,
      displayName: result.displayName,
      sessionsRevoked: null,
      warning: 'sessions_not_revoked',
    };
  }
  return { ok: true, action: 'reset-password', email: result.email, displayName: result.displayName, sessionsRevoked };
}

/** Answer one request from lfctl. Throws only when the database itself fails. */
export async function runOperatorRequest(raw: unknown): Promise<OperatorResponse> {
  const request = parseOperatorRequest(raw);
  if (!request) return { ok: false, error: 'invalid_request' };
  if (request.action === 'list-admins') {
    return { ok: true, action: 'list-admins', accounts: await listInstanceAdminAccounts(getDb()) };
  }
  return resetPassword(request.email, request.password);
}

/** The script's exit code for an answer: 0 done, 2 refused, 3 password changed but sessions still live. */
export function operatorExitCode(response: OperatorResponse): 0 | 2 | 3 {
  if (!response.ok) return 2;
  return response.action === 'reset-password' && response.warning ? 3 : 0;
}
