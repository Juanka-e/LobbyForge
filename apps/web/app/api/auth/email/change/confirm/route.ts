import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireMaterializedSession } from '@/lib/api-auth';
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
import { checkCode, checkLinkToken, MAX_CODE_ATTEMPTS } from '@/lib/mail/tokens';
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
 * POST /api/auth/email/change/confirm (docs/EMAIL.md §4.3) — `{ code }`
 * (the account's session) or `{ token }` (the link; no session needed).
 *
 * Applying it moves the account to the new address with
 * `email_verified_at = now()`, sends `change-notice` to the old address and
 * revokes the other sessions. The address must still be free: otherwise
 * 409 email_taken and nothing changes.
 *
 * 200 { changed: true, email } (+ `warning: "sessions_not_revoked"` when the
 * revocation failed); 400 invalid_code | expired | too_many_attempts |
 * invalid_token; 409 email_taken; 429 rate_limited.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error('invalid_request');

  try {
    const address = await hitAddress(req, TOKEN_POSTS_PER_ADDRESS);
    if (address.over) return rateLimitedResponse(address.retryAfter);

    let tokenId: string;
    let proofKind: 'link' | 'code';
    if ('token' in parsed.data) {
      const check = await checkLinkToken(parsed.data.token, 'change');
      if (!check.ok) return error(check.error);
      tokenId = check.row.id;
      proofKind = 'link';
    } else {
      const session = requireMaterializedSession(req);
      if (!session.ok) return session.response;
      const userId = session.session.uid;
      const limited = await hitOver(CODE_ATTEMPTS_PER_ACCOUNT, accountSubject(userId));
      if (limited.over) return rateLimitedResponse(limited.retryAfter);
      const check = await checkCode(userId, 'change', parsed.data.code);
      if (!check.ok) return error(check.error);
      tokenId = check.row.id;
      proofKind = 'code';
    }

    const result = await confirmEmailChange(
      req,
      proofKind === 'link' ? { kind: 'link', tokenId } : { kind: 'code', tokenId, maxAttempts: MAX_CODE_ATTEMPTS }
    );
    if (!result.ok) {
      if (result.error === 'email_taken') return error('email_taken', 409);
      return error(result.error === 'gone' && proofKind === 'code' ? 'expired' : proofKind === 'code' ? 'invalid_code' : 'invalid_token');
    }
    return NextResponse.json(
      { changed: true, email: result.email, ...(result.sessionsRevoked ? {} : { warning: 'sessions_not_revoked' }) },
      { headers: NO_STORE }
    );
  } catch (err) {
    if (err instanceof LimitStoreUnavailable) return rateLimitedResponse(5);
    throw err;
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maxBodyBytes: 1024,
});
