/**
 * The email status of the signed-in account, read while a page renders —
 * exactly the answer `GET /api/auth/email/status` gives (docs/EMAIL.md
 * §4.3): both come from `emailStatusFor` (lib/mail/status.ts). The lobby
 * and the hub pass it to the verification banner, so the banner is part of
 * the first paint instead of pushing the page down once a client fetch
 * comes back.
 *
 * Server-only. Never throws: `undefined` means "could not tell", and the
 * banner then asks the API itself.
 */
import { getUserEmailState } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { emailStatusFor } from '@/lib/mail/status';
import type { EmailStatus } from '@/components/email-verification/email-status';

export async function emailStatusForPage(userId: string | null | undefined): Promise<EmailStatus | null | undefined> {
  if (!userId) return null;
  try {
    const user = await getUserEmailState(getDb(), userId);
    // Signed out in the meantime, deleted, or a guest: nothing to show.
    if (!user || user.deletedAt || user.isGuest) return null;
    return await emailStatusFor(userId, { user });
  } catch (error) {
    console.error('[email-status] page read failed; the banner will ask the API', (error as Error).name || 'Error');
    return undefined;
  }
}
