/**
 * The `?t=` of an email link (`/verify-email`, `/reset-password`). The
 * server decides whether a token is good; this only keeps obvious junk
 * (an empty value, a repeated parameter, something far too long or with
 * characters a URL-safe token never has) from being offered a button that
 * could only fail.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9._~=-]{16,512}$/;

export function linkTokenFrom(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  return TOKEN_PATTERN.test(token) ? token : null;
}
