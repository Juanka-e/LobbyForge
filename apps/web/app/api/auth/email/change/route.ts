import { NextResponse } from 'next/server';
import { z } from 'zod';
import { changeUserEmailDirect, getUserCredentialsById, getUserEmailState, isEmailTaken } from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { accountLockedResponse, beginAccountAttempt, clearAccountAttempts } from '@/lib/auth-throttle';
import { getDb } from '@/lib/db';
import { isDisposableEmail } from '@/lib/mail/disposable';
import {
  accountSubject,
  CHANGE_SEND_LIMITS,
  hitAddress,
  LimitStoreUnavailable,
  rateLimitedResponse,
  secondsUntilAllowed,
  SENDS_PER_ADDRESS,
} from '@/lib/mail/limits';
import { ownSessionGid } from '@/lib/mail/change';
import { reserveChangeSend } from '@/lib/mail/verification';
import { revokeOtherSessions } from '@/lib/session-tracker';
import { appLink, dispatchMail, mailAvailability } from '@/lib/mail/send';
import { resolveMailSettings } from '@/lib/mail/settings';
import { preferredMailLocale } from '@/lib/mail/templates';
import { CODE_TTL_MS, issueChallenge, LINK_TTL_MS } from '@/lib/mail/tokens';
import { EmailAddressSchema } from '@/lib/mail/types';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '@/lib/password';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
const BodySchema = z
  .object({
    newEmail: z.string().max(320),
    currentPassword: z.string().min(1).max(128),
  })
  .strict();

function error(code: string, status = 400): NextResponse {
  return NextResponse.json({ error: code }, { status, headers: NO_STORE });
}

/**
 * POST /api/auth/email/change (docs/EMAIL.md §4.3) — `{ newEmail, currentPassword }`.
 *
 *   - verification `off` and no mail transport: the address changes at once
 *     (unverified) → 200 { changed: true };
 *   - otherwise the `change-confirm` email (code + link) goes to the NEW
 *     address and nothing changes until it is confirmed → 202 { pending: true }.
 *
 * Errors: 400 invalid_email | invalid_password | disposable_email; 409
 * email_taken; 429 rate_limited (the current-password check shares the
 * password change's per-account lock; the sends have their own per-account
 * buckets and share the per-target one with verification emails); 503
 * mail_unavailable | mail_quota.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error('invalid_request');
  const userId = session.session.uid;
  const email = EmailAddressSchema.safeParse(parsed.data.newEmail);
  if (!email.success) return error('invalid_email');
  const newEmail = email.data;

  // A stolen session must not get unlimited guesses at the password: the
  // same per-account counter as the password change.
  const subject = { scope: 'reauth', userId } as const;
  const attempt = await beginAccountAttempt(subject);
  if (!attempt.allowed) return accountLockedResponse(attempt.retryAfterSeconds);
  const credentials = await getUserCredentialsById(getDb(), userId);
  const passwordValid = await verifyPassword(parsed.data.currentPassword, credentials?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!credentials || credentials.deletedAt || credentials.isGuest || !credentials.passwordHash || !passwordValid) {
    return error('invalid_password');
  }
  await clearAccountAttempts(subject);

  if (credentials.email === newEmail) return error('invalid_email');
  const settings = await resolveMailSettings();
  if (settings.disposable.block && isDisposableEmail(newEmail, { allow: settings.disposable.allow, block: settings.disposable.blockExtra })) {
    return error('disposable_email');
  }
  if (await isEmailTaken(getDb(), newEmail, userId)) return error('email_taken', 409);

  const unavailable = await mailAvailability(settings);
  if (settings.verification.mode === 'off' && unavailable === 'mail_unavailable') {
    const changed = await changeUserEmailDirect(getDb(), userId, newEmail);
    if (!changed.ok) return changed.reason === 'email_taken' ? error('email_taken', 409) : error('invalid_password');
    // Like a confirmed change: the account's other sessions go.
    try {
      await revokeOtherSessions(userId, ownSessionGid(req, userId) ?? '');
    } catch (err) {
      console.error('[auth/email/change] other sessions could not be revoked', JSON.stringify((err as Error).message));
      return NextResponse.json({ changed: true, warning: 'sessions_not_revoked' }, { headers: NO_STORE });
    }
    return NextResponse.json({ changed: true }, { headers: NO_STORE });
  }

  try {
    // A cheap look first so a client inside its cooldown hears 429 before
    // anything else; the atomic reservation below is what really counts.
    const accountWait = await secondsUntilAllowed(CHANGE_SEND_LIMITS, accountSubject(userId));
    if (accountWait > 0) return rateLimitedResponse(accountWait);
    if (unavailable) return error(unavailable, 503);
    const address = await hitAddress(req, SENDS_PER_ADDRESS);
    if (address.over) return rateLimitedResponse(address.retryAfter);
    const reservation = await reserveChangeSend(userId, newEmail);
    if (!reservation.ok) return rateLimitedResponse(reservation.retryAfter);

    const challenge = await issueChallenge({ userId, purpose: 'change', targetEmail: newEmail });
    const user = await getUserEmailState(getDb(), userId);
    dispatchMail({
      to: newEmail,
      template: 'change-confirm',
      locale: preferredMailLocale(req, user?.locale),
      vars: {
        code: challenge.code,
        link: appLink('/verify-email', challenge.token),
        codeMinutes: CODE_TTL_MS / 60_000,
        linkHours: LINK_TTL_MS.change / 3_600_000,
      },
    });
    return NextResponse.json({ pending: true }, { status: 202, headers: NO_STORE });
  } catch (err) {
    if (err instanceof LimitStoreUnavailable) return rateLimitedResponse(5);
    throw err;
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 2048,
  rateLimit: { identifier: 'auth-email-change', config: { windowMs: 15 * 60_000, maxRequests: 20 } },
});
