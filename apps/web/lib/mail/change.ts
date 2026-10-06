/**
 * Applying an email change (docs/EMAIL.md §4.3 `change/confirm`): the
 * consumed challenge moves the account to the new, now verified address;
 * the OLD address gets the `change-notice`, and the account's other
 * sessions are revoked (the one confirming keeps working when it belongs
 * to the account; a link opened elsewhere signs every session out).
 *
 * Shared by `POST /api/auth/email/change/confirm` and the link page's
 * `POST /api/auth/email/verify` (a change link is a `/verify-email` link
 * too). Server-only.
 */
import { applyEmailChange, getUserEmailState, type EmailTokenProof } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { revokeOtherSessions } from '@/lib/session-tracker';
import { dispatchMail } from './send';
import { maskEmail, preferredMailLocale } from './templates';

export type ConfirmChangeResult =
  | { ok: true; email: string; sessionsRevoked: boolean }
  | { ok: false; error: 'email_taken' | 'gone' | 'user_gone' };

/** The request's own session gid, when it is signed in as `userId`. */
export function ownSessionGid(req: Request, userId: string): string | null {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  const session = readGuestSession(req.headers.get('cookie'), secret);
  return session?.uid === userId ? session.gid : null;
}

export async function confirmEmailChange(req: Request, proof: EmailTokenProof): Promise<ConfirmChangeResult> {
  const applied = await applyEmailChange(getDb(), proof);
  if (!applied.ok) return { ok: false, error: applied.reason };

  if (applied.oldEmail && applied.oldEmail !== applied.newEmail) {
    const user = await getUserEmailState(getDb(), applied.userId).catch(() => null);
    dispatchMail({ to: applied.oldEmail, template: 'change-notice', locale: preferredMailLocale(req, user?.locale), vars: { email: maskEmail(applied.newEmail) } });
  }

  let sessionsRevoked = true;
  try {
    // '' matches no session: a confirmation without the account's own session revokes them all.
    await revokeOtherSessions(applied.userId, ownSessionGid(req, applied.userId) ?? '');
  } catch (error) {
    sessionsRevoked = false;
    console.error('[mail] email changed but other sessions could not be revoked', JSON.stringify((error as Error).message));
  }
  return { ok: true, email: applied.newEmail, sessionsRevoked };
}
