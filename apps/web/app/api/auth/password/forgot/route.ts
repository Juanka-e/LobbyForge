import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserEmailStateByEmail } from '@lobbyforge/db';
import { guardCaptchaSurface } from '@/lib/captcha/guard';
import { CaptchaBodyFields } from '@/lib/captcha/types';
import { getDb } from '@/lib/db';
import {
  FORGOT_PER_TARGET,
  hitAddress,
  hitOver,
  LimitStoreUnavailable,
  peekAddress,
  rateLimitedResponse,
  SENDS_PER_ADDRESS,
  targetSubject,
} from '@/lib/mail/limits';
import { appLink, dispatchMail, mailAvailability } from '@/lib/mail/send';
import { resolveMailSettings } from '@/lib/mail/settings';
import { mailLocale, requestLocale } from '@/lib/mail/templates';
import { CODE_TTL_MS, issueChallenge, LINK_TTL_MS } from '@/lib/mail/tokens';
import { EmailAddressSchema } from '@/lib/mail/types';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
const BodySchema = z
  .object({
    email: z.string().max(320),
    // Bot protection (docs/CAPTCHA.md §4.3): the `password_reset` surface.
    ...CaptchaBodyFields,
  })
  .strict();

/** The answer for every address, known or not (§4.3). */
const ACCEPTED_BODY = { sent: true } as const;
/** Every accepted request takes at least this long, so the answer's timing says nothing either. */
const MIN_RESPONSE_MS = 250;

function error(code: string, status: number): NextResponse {
  return NextResponse.json({ error: code }, { status, headers: NO_STORE });
}

async function padded(startedAt: number): Promise<NextResponse> {
  const wait = MIN_RESPONSE_MS - (Date.now() - startedAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return NextResponse.json(ACCEPTED_BODY, { status: 202, headers: NO_STORE });
}

/**
 * The reset email, in the background. Silent on every path: an unknown
 * address, a guest, a deleted account, the 3/hour per-address cap and a
 * failed send all look exactly like a sent email to the caller.
 */
async function sendResetIfAccountExists(email: string, requesterLocale: string): Promise<void> {
  const user = await getUserEmailStateByEmail(getDb(), email);
  if (!user || user.deletedAt || user.isGuest || !user.email) return;
  const target = await hitOver(FORGOT_PER_TARGET, targetSubject(email));
  if (target.over) return;
  const challenge = await issueChallenge({ userId: user.id, purpose: 'reset', targetEmail: user.email });
  dispatchMail({
    to: user.email,
    template: 'reset',
    // users.locale when it is an explicit choice, else the requester's language.
    locale: user.locale && user.locale !== 'en' ? mailLocale(user.locale) : requesterLocale,
    vars: {
      code: challenge.code,
      link: appLink('/reset-password', challenge.token),
      codeMinutes: CODE_TTL_MS / 60_000,
      linkHours: LINK_TTL_MS.reset / 3_600_000,
    },
  });
}

/**
 * POST /api/auth/password/forgot (docs/EMAIL.md §4.3), no session.
 * `{ email, captchaToken?, captchaProvider?, formToken?, website? }`.
 *
 * Always 202 `{ sent: true }` — the same body and about the same time
 * whether or not an account has the address (the lookup and the send run
 * after the answer). Order: bounded body and origin → zod → mail
 * availability (503 `mail_unavailable` when there is no transport, so the
 * page can say "ask your administrator"; 503 `mail_quota` at the daily
 * limit — both instance-wide facts, not about the address) → the CAPTCHA
 * surface `password_reset` (default on) → 10 sends / 15 min per client
 * address → 202.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error('invalid_request', 400);
  const email = EmailAddressSchema.safeParse(parsed.data.email);
  if (!email.success) return error('invalid_email', 400);

  const unavailable = await mailAvailability(await resolveMailSettings());
  if (unavailable) return error(unavailable, 503);

  try {
    // Refuse a full bucket before a solved challenge is spent on it.
    const peeked = await peekAddress(req, SENDS_PER_ADDRESS);
    if (peeked.over) return rateLimitedResponse(peeked.retryAfter);
    const refused = await guardCaptchaSurface(req, parsed.data, 'password_reset');
    if (refused) return refused;
    const address = await hitAddress(req, SENDS_PER_ADDRESS);
    if (address.over) return rateLimitedResponse(address.retryAfter);
  } catch (err) {
    if (err instanceof LimitStoreUnavailable) return rateLimitedResponse(5);
    throw err;
  }

  void sendResetIfAccountExists(email.data, requestLocale(req)).catch((err: unknown) => {
    console.error('[auth/password/forgot] reset email not sent', JSON.stringify((err as Error).message));
  });
  return padded(startedAt);
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  sessionRevocation: 'bypass',
  // Room for a CAPTCHA token (up to 4096 characters) next to the form.
  maxBodyBytes: 12 * 1024,
});
