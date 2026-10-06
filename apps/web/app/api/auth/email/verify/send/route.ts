import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserEmailState } from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import {
  ACCOUNT_SEND_LIMITS,
  accountSubject,
  hitAddress,
  LimitStoreUnavailable,
  rateLimitedResponse,
  secondsUntilAllowed,
  SENDS_PER_ADDRESS,
} from '@/lib/mail/limits';
import { mailAvailability } from '@/lib/mail/send';
import { resolveMailSettings } from '@/lib/mail/settings';
import { preferredMailLocale } from '@/lib/mail/templates';
import { startEmailVerification } from '@/lib/mail/verification';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
const BodySchema = z.object({}).strict();

function error(code: string, status: number): NextResponse {
  return NextResponse.json({ error: code }, { status, headers: NO_STORE });
}

/**
 * POST /api/auth/email/verify/send (docs/EMAIL.md §4.3) — (re)send the
 * verification email to the signed-in account's address. A new send
 * replaces the previous code and link. Answers 202 at once; SMTP happens in
 * the background.
 *
 * Errors: 400 no_email (a guest), 409 already_verified, 429 rate_limited
 * (`retryAfter`), 503 mail_unavailable / mail_quota.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const session = requireMaterializedSession(req);
  if (!session.ok) return session.response;
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return error('invalid_request', 400);
  const userId = session.session.uid;

  const user = await getUserEmailState(getDb(), userId);
  if (!user || user.deletedAt) return NextResponse.json({ error: 'Authentication required' }, { status: 401, headers: NO_STORE });
  if (user.isGuest || !user.email) return error('no_email', 400);
  if (user.emailVerifiedAt) return error('already_verified', 409);

  try {
    // A cheap look first, so a client inside its cooldown hears 429 before
    // any other answer. The authoritative check is the atomic reservation
    // in startEmailVerification: a burst cannot slip between them.
    const wait = await secondsUntilAllowed(ACCOUNT_SEND_LIMITS, accountSubject(userId));
    if (wait > 0) return rateLimitedResponse(wait);

    const unavailable = await mailAvailability(await resolveMailSettings());
    if (unavailable) return error(unavailable, 503);

    const address = await hitAddress(req, SENDS_PER_ADDRESS);
    if (address.over) return rateLimitedResponse(address.retryAfter);

    const started = await startEmailVerification({ id: userId, email: user.email, locale: preferredMailLocale(req, user.locale) });
    if (!started.ok) return rateLimitedResponse(started.retryAfter);
    return NextResponse.json({ sent: true, resendAvailableAt: started.resendAvailableAt.toISOString() }, { status: 202, headers: NO_STORE });
  } catch (err) {
    if (err instanceof LimitStoreUnavailable) return rateLimitedResponse(5);
    throw err;
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 1024,
});
