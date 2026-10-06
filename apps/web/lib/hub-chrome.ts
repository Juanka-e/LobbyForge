/**
 * Where the app's global header (`app/GlobalHeader.tsx`) steps aside.
 *
 * Hub pages draw their own header and footer (`HubShell`); the lobby,
 * settings, admin and sign-in surfaces have layouts of their own. Before
 * this list existed the global header stacked on top of those headers.
 */

/**
 * Pages with their own chrome in every deployment. The Developers section
 * is hub chrome on the official hub and its own standalone frame on a
 * self-hosted instance (`app/(developers)/layout.tsx`).
 */
const OWN_CHROME_EXACT = new Set([
  '/landing',
  '/home',
  '/download',
  '/marketplace',
  '/register',
  '/login',
  // Account recovery and email links draw the sign-in card (app/login/AuthFlowFrame.tsx).
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/setup',
  '/developers',
]);
const OWN_CHROME_PREFIXES = ['/lobby', '/admin', '/settings', '/servers/', '/developers/'];

/**
 * Official-hub pages drawn in the hub chrome. `/discover` and `/instances`
 * exist only on the official hub; `/connect` also serves self-hosted
 * instances, which keep the global header on it. `/connect/demo` is a
 * developer surface and keeps it everywhere.
 */
const HUB_EXACT = new Set(['/connect']);
const HUB_PREFIXES = ['/discover', '/instances'];

export function isAppHeaderHidden(pathname: string | null, official: boolean): boolean {
  if (!pathname) return false;
  if (OWN_CHROME_EXACT.has(pathname)) return true;
  if (OWN_CHROME_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  if (!official) return false;
  return HUB_EXACT.has(pathname) || HUB_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
