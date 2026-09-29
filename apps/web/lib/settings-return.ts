/**
 * Where closing the settings modal goes.
 *
 * Self-hosted instance: the lobby, always — the canonical contract
 * (docs/WEB_APP.md, e2e/settings-modal.spec.ts).
 *
 * Official hub: back where the visitor came from. Many hub users have no
 * community yet, and their `/lobby` is only the demo, so closing settings
 * opened from the hub home must not land there. `SettingsReturnTracker`
 * remembers the last page that is a place to come back to (per tab, in
 * sessionStorage); with nothing remembered, the hub home.
 */
import { HUB_HOME_PATH } from './hub-routes';

export const SETTINGS_RETURN_KEY = 'lf:settings-return';

/**
 * Pages that are not a place to come back to: the modal surfaces
 * themselves, the create-a-community flow (after it, the hub home shows
 * the new community) and the sign-in pages.
 */
const NOT_A_RETURN_POINT = [
  /^\/settings(\/|$)/,
  /^\/admin(\/|$)/,
  /^\/servers\//,
  /^\/instances(\/|$)/,
  /^\/(login|register|setup)$/,
];

export function isReturnPoint(pathname: string): boolean {
  return pathname.startsWith('/') && !NOT_A_RETURN_POINT.some((pattern) => pattern.test(pathname));
}

/**
 * A remembered value → a same-origin path that is safe to navigate to, or
 * null. sessionStorage is script-writable, so it is checked like any input:
 * only a single-slash relative path, no scheme, no backslash, no control
 * characters (the same rules as `sanitizeOAuthRedirect`).
 */
export function parseReturnPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2048) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (raw.includes('\\') || raw.includes('://')) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const pathname = raw.split(/[?#]/, 1)[0] ?? '';
  return isReturnPoint(pathname) ? raw : null;
}

export function settingsCloseTarget(input: { official: boolean; remembered: string | null }): string {
  if (!input.official) return '/lobby';
  return parseReturnPath(input.remembered) ?? HUB_HOME_PATH;
}
