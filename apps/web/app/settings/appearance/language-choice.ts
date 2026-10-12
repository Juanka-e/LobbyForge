import { clearLocaleCookie, serializeLocaleCookie } from '@/lib/i18n/locale-cookie';

/**
 * Save a language choice from the picker: on the ACCOUNT first, so the
 * desktop app and the user's other browsers follow it, then in this
 * browser's `lf_locale` cookie, which keeps it after signing out. "system"
 * ("Match my browser") clears both.
 *
 * The account is written first because it wins over the cookie when the
 * page renders: a cookie written after a failed save would change nothing
 * the user can see. Returns false when the account could not be saved —
 * the caller says so and does not reload.
 */
export async function saveLanguageChoice(
  choice: string,
  io: {
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    writeCookie: (cookie: string) => void;
  }
): Promise<boolean> {
  const locale = choice === 'system' ? null : choice;
  let res: Response;
  try {
    res = await io.fetch('/api/settings/me', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale }),
    });
  } catch {
    return false;
  }
  if (!res.ok) return false;
  try {
    io.writeCookie(locale === null ? clearLocaleCookie() : serializeLocaleCookie(locale));
  } catch {
    // Cookies blocked: the account has the choice, which is what the next
    // render reads for a signed-in user.
  }
  return true;
}
