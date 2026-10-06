/**
 * Email verification rules (docs/EMAIL.md §4.1, §4.2) and the server-side
 * gate, `requireVerifiedEmail(user, action)`.
 *
 * In `required` mode an account is RESTRICTED only when all of these hold:
 *   - it has an address and is not verified;
 *   - it was created after `enforced_since`, or `existing_deadline` passed;
 *   - it is not the owner (the instance admin);
 *   - it is not a guest (guests have no address and are never restricted).
 * `optional` restricts nothing (the UI shows a banner); `off` neither.
 *
 * A restricted account can still sign in, read, change its settings and
 * profile, change its address and delete itself. It is refused, with 403
 * `{ "error": "email_unverified" }`, the actions in VERIFIED_ACTIONS.
 *
 * Fast path: outside `required` the gate answers from the cached settings
 * without touching the database. When the account or the settings cannot
 * be read it lets the request through (fail open): the action itself needs
 * the database and will fail on its own.
 */
import { NextResponse } from 'next/server';
import { getInstanceSetupStatus, getUserEmailState, type UserEmailState } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { changeSendEntries, reserveWindows, verificationSendEntries } from './limits';
import { appLink, dispatchMail, mailAvailability } from './send';
import { resolveMailSettings, type ResolvedMailSettings } from './settings';
import { CODE_TTL_MS, issueChallenge, LINK_TTL_MS } from './tokens';
import type { EmailVerificationMode, EmailVerificationScope, VerifiedAction } from './types';

export interface RestrictionInput {
  mode: EmailVerificationMode;
  scope: EmailVerificationScope;
  enforcedSince: Date | null;
  existingDeadline: Date | null;
  ownerUserId: string | null;
  user: Pick<UserEmailState, 'id' | 'email' | 'emailVerifiedAt' | 'isGuest' | 'createdAt' | 'deletedAt' | 'signupChannel'>;
}

/**
 * Is an account of this sign-up channel one the instance asks to verify?
 * `open` and `invite` follow the scope (an invite is already a gate, so by
 * default invite sign-ups need not verify — like CAPTCHA's
 * `invite_register`); `oauth` (Google vouched) and `setup` (the owner)
 * never; null (an account from before 0046) always — the enforced_since /
 * deadline rules decide for those.
 */
export function signupChannelInScope(channel: UserEmailState['signupChannel'], scope: EmailVerificationScope): boolean {
  switch (channel) {
    case 'open':
      return scope.open_register;
    case 'invite':
      return scope.invite_register;
    case 'oauth':
    case 'setup':
      return false;
    default:
      return true;
  }
}

/** Pure: is this account restricted right now? */
export function isEmailRestricted(input: RestrictionInput, now = new Date()): boolean {
  if (input.mode !== 'required') return false;
  const { user } = input;
  if (user.isGuest || !user.email || user.emailVerifiedAt) return false;
  if (input.ownerUserId && user.id === input.ownerUserId) return false;
  if (!signupChannelInScope(user.signupChannel, input.scope)) return false;
  const newAccount = input.enforcedSince !== null && user.createdAt.getTime() > input.enforcedSince.getTime();
  const deadlinePassed = input.existingDeadline !== null && input.existingDeadline.getTime() <= now.getTime();
  return newAccount || deadlinePassed;
}

/** The owner's id; `undefined` when it cannot be read (the caller fails open). */
async function ownerUserId(): Promise<string | null | undefined> {
  try {
    const setup = await getInstanceSetupStatus(getDb());
    return setup.ownerUserId ?? null;
  } catch {
    return undefined;
  }
}

/** The account's restriction state, reading what it needs. Null user → not restricted. */
export async function emailRestrictionFor(
  userId: string,
  options: { settings?: ResolvedMailSettings; user?: UserEmailState | null } = {}
): Promise<{ restricted: boolean; user: UserEmailState | null; settings: ResolvedMailSettings }> {
  const settings = options.settings ?? (await resolveMailSettings());
  if (settings.verification.mode !== 'required') return { restricted: false, user: options.user ?? null, settings };
  const user = options.user !== undefined ? options.user : await getUserEmailState(getDb(), userId);
  if (!user || user.deletedAt) return { restricted: false, user, settings };
  const owner = await ownerUserId();
  // The owner can never be restricted: when we cannot tell who the owner is,
  // nobody is (fail open, like unreadable settings).
  if (owner === undefined) return { restricted: false, user, settings };
  const restricted = isEmailRestricted({
    mode: settings.verification.mode,
    scope: settings.verification.scope,
    enforcedSince: settings.verification.enforcedSince,
    existingDeadline: settings.verification.existingDeadline,
    ownerUserId: owner,
    user,
  });
  return { restricted, user, settings };
}

export function emailUnverifiedResponse(): NextResponse {
  return NextResponse.json({ error: 'email_unverified' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * The gate for the actions a restricted account may not take (§4.2).
 * Null when the request may go on; a 403 `{ error: "email_unverified" }`
 * otherwise. `action` names what is being attempted (logged, and kept for
 * the tests that prove every protected route calls this).
 */
export async function requireVerifiedEmail(user: string | { id: string }, action: VerifiedAction): Promise<NextResponse | null> {
  const userId = typeof user === 'string' ? user : user.id;
  try {
    const settings = await resolveMailSettings();
    if (settings.verification.mode !== 'required') return null;
    const { restricted } = await emailRestrictionFor(userId, { settings });
    if (!restricted) return null;
    console.info(`[mail] refused ${action}: email not verified`);
    return emailUnverifiedResponse();
  } catch (error) {
    console.error('[mail] verification check failed; letting the request through', JSON.stringify((error as Error).message));
    return null;
  }
}

/**
 * Does a new sign-up get a verification email (§4.1)? In `optional` and
 * `required`, when the sign-up is in scope: `open_register` (no invite —
 * also every official hub sign-up) and/or `invite_register`.
 */
export function signupInVerificationScope(settings: ResolvedMailSettings, input: { invite: boolean }): boolean {
  if (settings.verification.mode === 'off') return false;
  const invite = input.invite && !isOfficialDeployment();
  return invite ? settings.verification.scope.invite_register : settings.verification.scope.open_register;
}

/**
 * Reserve one verification email against the account's verify cooldown,
 * hourly and daily caps and the target address's hourly cap — atomically,
 * all or nothing (docs/EMAIL.md §4.4), so a burst cannot slip through
 * between a check and a count.
 */
export async function reserveVerificationSend(userId: string, targetEmail: string) {
  return reserveWindows(verificationSendEntries(userId, targetEmail));
}

/**
 * Reserve one email-change confirmation: the account's OWN change cooldown,
 * hourly and daily caps (so a typo can be fixed right after sign-up) and the
 * target's hourly cap, shared with verification emails — atomically.
 */
export async function reserveChangeSend(userId: string, targetEmail: string) {
  return reserveWindows(changeSendEntries(userId, targetEmail));
}

export type StartedVerification =
  | {
      ok: true;
      /** When the next send is allowed (the resend cooldown and the hourly/daily caps). */
      resendAvailableAt: Date;
    }
  | { ok: false; retryAfter: number };

/**
 * Reserve a send (refused → `{ ok: false, retryAfter }`), then create a
 * verify challenge and send the `verify` email WITHOUT waiting for SMTP.
 * The caller checked the mail availability first.
 */
export async function startEmailVerification(user: { id: string; email: string; locale?: string | null }): Promise<StartedVerification> {
  const reservation = await reserveVerificationSend(user.id, user.email);
  if (!reservation.ok) return { ok: false, retryAfter: reservation.retryAfter };
  const wait = reservation.wait;
  const challenge = await issueChallenge({ userId: user.id, purpose: 'verify', targetEmail: user.email });
  dispatchMail({
    to: user.email,
    template: 'verify',
    locale: user.locale,
    vars: {
      code: challenge.code,
      link: appLink('/verify-email', challenge.token),
      codeMinutes: CODE_TTL_MS / 60_000,
      linkHours: LINK_TTL_MS.verify / 3_600_000,
    },
  });
  return { ok: true, resendAvailableAt: new Date(Date.now() + Math.max(wait, 1) * 1000) };
}

/**
 * Sign-up (register route): when in scope and mail is configured, start
 * the verification in the BACKGROUND — the response never waits, and
 * nothing here can fail the sign-up. Returns whether a send was started.
 */
export async function maybeStartSignupVerification(user: { id: string; email: string; locale?: string | null }, input: { invite: boolean }): Promise<boolean> {
  try {
    const settings = await resolveMailSettings();
    if (!signupInVerificationScope(settings, input)) return false;
    if (await mailAvailability(settings)) return false;
    void startEmailVerification(user).catch((error: unknown) => {
      console.error('[mail] sign-up verification could not start', JSON.stringify((error as Error).message));
    });
    return true;
  } catch (error) {
    console.error('[mail] sign-up verification skipped', JSON.stringify((error as Error).message));
    return false;
  }
}
