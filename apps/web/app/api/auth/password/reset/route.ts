import { NextResponse } from 'next/server';
import { z } from 'zod';
import { applyPasswordReset, getUserEmailStateByEmail, type EmailTokenProof } from '@lobbyforge/db';
import { clearAccountAttempts } from '@/lib/auth-throttle';
import { getDb } from '@/lib/db';
import { revokeDesktopHandoffCodes } from '@/lib/desktop-handoff-codes';
import {
  hitAddress,
  hitOver,
  LimitStoreUnavailable,
  rateLimitedResponse,
  RESET_CODE_ATTEMPTS,
  resetCodeSubject,
  TOKEN_POSTS_PER_ADDRESS,
} from '@/lib/mail/limits';
import { checkCode, checkLinkToken, MAX_CODE_ATTEMPTS } from '@/lib/mail/tokens';
import { EmailAddressSchema, EmailCodeSchema, EmailLinkTokenSchema } from '@/lib/mail/types';
import { MIN_PASSWORD_LENGTH } from '@/lib/password-strength';
import { hashPassword } from '@/lib/password';
import { withApiSecurity } from '@/lib/security-headers';
import { revokeOtherSessions } from '@/lib/session-tracker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
// The sign-up policy (register route): 12–128 characters.
const NewPassword = z.string().max(128);
const BodySchema = z.union([
  z.object({ token: EmailLinkTokenSchema, newPassword: NewPassword }).strict(),
  z.object({ email: z.string().max(320), code: EmailCodeSchema, newPassword: NewPassword }).strict(),
]);

function error(code: string, status = 400): NextResponse {
  return NextResponse.json({ error: code }, { status, headers: NO_STORE });
}

/**
 * POST /api/auth/password/reset (docs/EMAIL.md §4.3), no session.
 * `{ token, newPassword }` (the link, valid 60 minutes) or
 * `{ email, code, newPassword }` (the code, 15 minutes, 5 attempts).
 *
 * On success: the new password (sign-up policy: 12–128 characters), the
 * address marked verified, EVERY session revoked and every device cookie
 * void (they are bound to the password hash), pending desktop handoff codes
 * dropped and the sign-in lock for the address cleared — the
 * password-change machinery, minus the "keep this session" part. It never
 * signs anyone in.
 *
 * 200 { reset: true } (+ `warning: "sessions_not_revoked"`); 400
 * weak_password; 400 invalid_token | expired (the link); 429 rate_limited.
 * By code, EVERY failure — a wrong, used-up or expired code, an unknown or
 * guest account, an address that changed since — is the same 400
 * invalid_code, and the attempts count in a budget of their own keyed by
 * the address typed (10 / 15 min, never shared with verify or change), so
 * nothing tells one address from another.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error('invalid_request');
  if (parsed.data.newPassword.length < MIN_PASSWORD_LENGTH) return error('weak_password');

  let proof: EmailTokenProof;
  try {
    const address = await hitAddress(req, TOKEN_POSTS_PER_ADDRESS);
    if (address.over) return rateLimitedResponse(address.retryAfter);

    if ('token' in parsed.data) {
      const check = await checkLinkToken(parsed.data.token, 'reset');
      if (!check.ok) return error(check.error);
      proof = { kind: 'link', tokenId: check.row.id };
    } else {
      const email = EmailAddressSchema.safeParse(parsed.data.email);
      if (!email.success) return error('invalid_code');
      // Counted before the account is looked up, by the address typed: the
      // same budget and the same answers whether or not an account has it.
      const limited = await hitOver(RESET_CODE_ATTEMPTS, resetCodeSubject(email.data));
      if (limited.over) return rateLimitedResponse(limited.retryAfter);
      const user = await getUserEmailStateByEmail(getDb(), email.data);
      if (!user || user.deletedAt || user.isGuest) return error('invalid_code');
      const check = await checkCode(user.id, 'reset', parsed.data.code);
      if (!check.ok) return error('invalid_code');
      proof = { kind: 'code', tokenId: check.row.id, maxAttempts: MAX_CODE_ATTEMPTS };
    }
  } catch (err) {
    if (err instanceof LimitStoreUnavailable) return rateLimitedResponse(5);
    throw err;
  }

  const result = await applyPasswordReset(getDb(), proof, await hashPassword(parsed.data.newPassword));
  if (!result.ok) return error(proof.kind === 'code' ? 'invalid_code' : 'invalid_token');

  await revokeDesktopHandoffCodes(result.userId).catch((err: unknown) => {
    console.error('[auth/password/reset] failed to clear desktop handoff codes', JSON.stringify((err as Error).message));
  });
  if (result.email) {
    await clearAccountAttempts({ scope: 'sign-in', email: result.email }).catch(() => undefined);
  }
  try {
    // '' matches no session: all of them go.
    await revokeOtherSessions(result.userId, '');
  } catch (err) {
    console.error('[auth/password/reset] failed to revoke sessions', JSON.stringify((err as Error).message));
    return NextResponse.json({ reset: true, warning: 'sessions_not_revoked' }, { headers: NO_STORE });
  }
  return NextResponse.json({ reset: true }, { headers: NO_STORE });
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  sessionRevocation: 'bypass',
  maxBodyBytes: 2048,
});
