import { NextResponse } from 'next/server';
import { z } from 'zod';
import { applyEmailVerification, getEmailTokenByHash, getUserEmailState } from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { confirmEmailChange } from '@/lib/mail/change';
import {
  accountSubject,
  CODE_ATTEMPTS_PER_ACCOUNT,
  hitAddress,
  hitOver,
  LimitStoreUnavailable,
  rateLimitedResponse,
  TOKEN_POSTS_PER_ADDRESS,
} from '@/lib/mail/limits';
import { checkCode, checkLinkToken, hashLinkToken, MAX_CODE_ATTEMPTS } from '@/lib/mail/tokens';
import { EmailCodeSchema, EmailLinkTokenSchema } from '@/lib/mail/types';
import { withApiSecurity } from '@/lib/security-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
const BodySchema = z.union([z.object({ code: EmailCodeSchema }).strict(), z.object({ token: EmailLinkTokenSchema }).strict()]);

function error(code: string, status = 400): NextResponse {
  return NextResponse.json({ error: code }, { status, headers: NO_STORE });
}

/**
 * POST /api/auth/email/verify (docs/EMAIL.md §4.3) — prove the address.
 *
 *   { code }  the 6-digit code; needs the account's session.
 *   { token } the link token from `/verify-email?t=…`; no session needed,
 *             and it never signs anyone in. The confirmation page's button
 *             POSTs here: a GET never consumes anything (link scanners).
 *             A change link (`change-confirm`) points to the same page, so
 *             a change token is accepted here too and applies the change.
 *
 * 200 { verified: true } (a change token: { verified: true, changed: true }).
 * 400 invalid_code | expired | too_many_attempts | invalid_token;
 * 409 email_taken (change token, the address was taken meanwhile);
 * 429 rate_limited (10 POSTs / min per client address; 10 code attempts
 * per account / 15 min).
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error('invalid_request');

  try {
    const address = await hitAddress(req, TOKEN_POSTS_PER_ADDRESS);
    if (address.over) return rateLimitedResponse(address.retryAfter);

    if ('token' in parsed.data) {
      const token = parsed.data.token;
      const hash = hashLinkToken(token);
      const row = hash ? await getEmailTokenByHash(getDb(), hash) : null;
      if (row?.purpose === 'change') {
        const check = await checkLinkToken(token, 'change');
        if (!check.ok) return error(check.error);
        const changed = await confirmEmailChange(req, { kind: 'link', tokenId: check.row.id });
        if (changed.ok) return NextResponse.json({ verified: true, changed: true }, { headers: NO_STORE });
        return changed.error === 'email_taken' ? error('email_taken', 409) : error('invalid_token');
      }
      const check = await checkLinkToken(token, 'verify');
      if (!check.ok) return error(check.error);
      const applied = await applyEmailVerification(getDb(), { kind: 'link', tokenId: check.row.id });
      return applied.ok ? NextResponse.json({ verified: true }, { headers: NO_STORE }) : error('invalid_token');
    }

    const session = requireMaterializedSession(req);
    if (!session.ok) return session.response;
    const userId = session.session.uid;
    const limited = await hitOver(CODE_ATTEMPTS_PER_ACCOUNT, accountSubject(userId));
    if (limited.over) return rateLimitedResponse(limited.retryAfter);

    const user = await getUserEmailState(getDb(), userId);
    if (user?.emailVerifiedAt) return NextResponse.json({ verified: true }, { headers: NO_STORE });
    const check = await checkCode(userId, 'verify', parsed.data.code);
    if (!check.ok) return error(check.error);
    const applied = await applyEmailVerification(getDb(), { kind: 'code', tokenId: check.row.id, maxAttempts: MAX_CODE_ATTEMPTS });
    if (applied.ok) return NextResponse.json({ verified: true }, { headers: NO_STORE });
    return error(applied.reason === 'gone' ? 'expired' : 'invalid_code');
  } catch (err) {
    if (err instanceof LimitStoreUnavailable) return rateLimitedResponse(5);
    throw err;
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 1024,
});
