/**
 * The Google sign-in state cookie's name.
 *
 * In production it carries the `__Host-` prefix: the browser then accepts it
 * only from this exact host, over HTTPS, with `Path=/` and no `Domain`. A
 * sibling subdomain of the same parent domain can therefore not plant a
 * state of its own and finish a sign-in with the attacker's Google code in
 * the victim's browser (login CSRF). Plain-HTTP development cannot set a
 * `__Host-` cookie, so it keeps the bare name.
 */
export function oauthStateCookieName(env: Record<string, string | undefined> = process.env): string {
  return env.NODE_ENV === 'production' ? '__Host-lf_oauth_state' : 'lf_oauth_state';
}
