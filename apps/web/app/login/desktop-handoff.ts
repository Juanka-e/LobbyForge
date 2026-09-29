/**
 * Desktop browser-login flow, shared by both sign-in forms: the NATIVE
 * shell opened the sign-in page with its own pending state
 * (`?desktopLoginState=…`). After a successful sign-in, mint the one-time
 * handoff bound to that state, then hand control back through the
 * `lobbyforge://` deep link — the shell drops it unless the state
 * matches its pending entry.
 *
 * Returns true when control went back to the shell. On false the handoff
 * could not be minted and the caller continues on the web; the desktop
 * shell simply does not receive a session.
 */
export async function completeDesktopHandoff(input: {
  email: string;
  password: string;
  state: string;
}): Promise<boolean> {
  const handoff = await fetch('/api/auth/desktop-session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).catch(() => null);
  const body = handoff ? ((await handoff.json().catch(() => ({}))) as { redirectUrl?: string }) : {};
  if (handoff?.ok && body.redirectUrl) {
    window.location.href = body.redirectUrl;
    return true;
  }
  return false;
}
