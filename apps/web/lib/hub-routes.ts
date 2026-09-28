/**
 * Where the official hub sends people — kept in one pure module so every
 * rule is tested together instead of living as a `redirect()` buried in
 * each page.
 *
 * The official hub has public pages (landing, directory, marketplace,
 * download), official accounts (sign in / sign up) and a signed-in home.
 * A self-hosted instance is one community: it never shows the hub, and
 * its entry rules are unchanged (lobby when signed in, else its own
 * instance-branded sign-in).
 */

export const HUB_HOME_PATH = '/home';
export const HUB_LANDING_PATH = '/landing';
export const SIGN_IN_PATH = '/login';

export interface Visitor {
  /** `isOfficialDeployment()` */
  official: boolean;
  /** A valid session with a materialized user (`session.uid`). */
  signedIn: boolean;
}

/** `/` — the front door. */
export function rootDestination({ official, signedIn }: Visitor): '/home' | '/landing' | '/lobby' | '/login' {
  if (official) return signedIn ? HUB_HOME_PATH : HUB_LANDING_PATH;
  return signedIn ? '/lobby' : SIGN_IN_PATH;
}

/**
 * The official sign-in and sign-up pages: someone already signed in has
 * nothing to do there, so they go on to the hub home. `null` = stay.
 */
export function officialAuthDestination(signedIn: boolean): '/home' | null {
  return signedIn ? HUB_HOME_PATH : null;
}

/**
 * The hub home exists only on the official hub (a self-hosted instance's
 * home is its lobby) and only for someone signed in. `null` = render it.
 */
export function hubHomeDestination({ official, signedIn }: Visitor): '/lobby' | '/login' | null {
  if (!official) return '/lobby';
  if (!signedIn) return SIGN_IN_PATH;
  return null;
}
