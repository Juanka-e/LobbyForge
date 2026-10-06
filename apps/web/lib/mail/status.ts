/**
 * The email status of an account (docs/EMAIL.md §4.3) — the ONE builder of
 * the `GET /api/auth/email/status` answer:
 *
 *   { email, verified, mode, restricted, pendingChange, resendAvailableAt, mailConfigured }
 *
 * The status route answers it, and `lib/email-status-ssr.ts` hands it to
 * the verification banner while a page renders, so the two can never
 * disagree.
 *
 * `pendingChange` is the address a live email-change challenge was sent to
 * (the account's own request, so showing it back is fine);
 * `resendAvailableAt` comes from the per-account send limits (§4.4) and is
 * null when a send is allowed now — or when the limit store cannot be read
 * (the send route then decides). Server-only.
 */
import { getActiveEmailToken, getUserEmailState, type UserEmailState } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { accountSubject, ACCOUNT_SEND_LIMITS, secondsUntilAllowed } from './limits';
import { mailAvailability } from './send';
import { resolveMailSettings, type ResolvedMailSettings } from './settings';
import type { EmailVerificationMode } from './types';
import { emailRestrictionFor } from './verification';

export interface EmailStatusView {
  email: string | null;
  verified: boolean;
  mode: EmailVerificationMode;
  restricted: boolean;
  pendingChange: string | null;
  resendAvailableAt: string | null;
  mailConfigured: boolean;
}

/**
 * The status of `userId`, or null when there is no such account (or it was
 * deleted). Pass `user` when the caller already read it, `settings` when it
 * already resolved them. A guest gets a status too (no address, so no
 * pending change); callers that show nothing to guests check `isGuest`
 * themselves.
 */
export async function emailStatusFor(
  userId: string,
  options: { user?: UserEmailState | null; settings?: ResolvedMailSettings } = {}
): Promise<EmailStatusView | null> {
  const user = options.user !== undefined ? options.user : await getUserEmailState(getDb(), userId);
  if (!user || user.deletedAt) return null;

  const settings = options.settings ?? (await resolveMailSettings());
  const { restricted } = await emailRestrictionFor(userId, { settings, user });
  const change = user.isGuest ? null : await getActiveEmailToken(getDb(), userId, 'change');
  const pendingChange = change && change.expiresAt.getTime() > Date.now() ? change.targetEmail : null;

  let resendAvailableAt: string | null = null;
  try {
    const wait = await secondsUntilAllowed(ACCOUNT_SEND_LIMITS, accountSubject(userId));
    if (wait > 0) resendAvailableAt = new Date(Date.now() + wait * 1000).toISOString();
  } catch {
    // The limit store is down (production fails closed there): no cooldown
    // to show — the send route answers 429 itself if it must.
  }

  return {
    email: user.email,
    verified: user.emailVerifiedAt !== null,
    mode: settings.verification.mode,
    restricted,
    pendingChange,
    resendAvailableAt,
    mailConfigured: (await mailAvailability(settings)) !== 'mail_unavailable',
  };
}
