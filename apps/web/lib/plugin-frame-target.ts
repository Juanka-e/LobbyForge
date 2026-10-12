/**
 * Where a marketplace plugin's frame points (ADR-007, docs/PLUGIN_UNLOCK_PLAN.md
 * phase 2), shared by the server (frame info, the app's `frame-src`, the
 * installer) and the lobby (PluginFrame). No Node imports: it runs in the
 * browser too.
 *
 * Two kinds of UI:
 *  - the plugin's own files (`ui: true`), served by /api/plugin-ui into
 *    `<iframe sandbox="allow-scripts">`: an opaque origin;
 *  - the author's own site (`ui: { url }`), approved by the instance owner at
 *    install and framed directly with `sandbox="allow-scripts
 *    allow-same-origin allow-forms allow-pointer-lock"`.
 *
 * `allow-same-origin` gives the site its real origin — its own cookies and
 * storage, as on any embed — and is safe ONLY because that origin is not the
 * app's: a frame that is same-origin with its parent and may run scripts can
 * reach into the parent's DOM and take its own sandbox attribute off. So the
 * site must not be on the app's address. Stricter than "not the same origin":
 * cookies are scoped by host, not by port or scheme, and a subdomain can set
 * cookies for its parent domain, so a page on the app's host (any port) or on
 * a subdomain of it — or an app on a subdomain of the page's host — is
 * refused as well (`externalUiOrigin`). Sibling subdomains of one registrable
 * domain cannot be told apart without the Public Suffix List; the approval
 * dialog names the site, and the owner should not approve one on their own
 * domain.
 */

/** The path the lobby frames for a plugin's own files (`ui: true`). */
export function pluginFrameSrc(pluginId: string, version: string): string {
  return `/api/plugin-ui/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/index.html`;
}

/** The sandbox of a plugin's own files: scripts only, an opaque origin. */
export const FILES_FRAME_SANDBOX = 'allow-scripts';

/**
 * The sandbox of an author's own site: its real origin (its own cookies and
 * storage), forms and pointer lock for games. Never `allow-top-navigation`,
 * `allow-popups` or `allow-modals`: the site cannot navigate the lobby away,
 * open windows or block it with dialogs.
 */
export const EXTERNAL_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-pointer-lock';

/** The http(s) origin of a URL, or null. */
export function httpOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The origins the app answers on, de-duplicated: each value that is an http(s) URL. */
export function appOrigins(values: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const origin = httpOrigin(value);
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/** The configured public origins of the instance (`LOBBYFORGE_APP_ORIGIN`, `NEXT_PUBLIC_BASE_URL`). */
export function configuredAppOrigins(env: Record<string, string | undefined> = process.env): string[] {
  return appOrigins([env.LOBBYFORGE_APP_ORIGIN, env.NEXT_PUBLIC_BASE_URL]);
}

/** One host is the other, or a subdomain of it. */
function hostsOverlap(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * The origin of an external plugin UI, when the lobby may frame it with
 * `allow-same-origin`; null when it must not be framed at all: not an
 * http(s) URL, carries credentials, or sits on one of `apps`' hosts (or a
 * subdomain either way — see the header). Whether `http:` and local hosts
 * are acceptable is the manifest validator's call (sandbox-manifest.ts),
 * made before a URL ever gets here.
 */
export function externalUiOrigin(url: string, apps: readonly string[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password || !parsed.hostname) return null;
  for (const app of apps) {
    let host: string;
    try {
      host = new URL(app).hostname;
    } catch {
      continue;
    }
    if (host && hostsOverlap(parsed.hostname, host)) return null;
  }
  return parsed.origin;
}

/**
 * An origin a CSP may carry verbatim: `scheme://host[:port]` with a plain
 * host. The manifest validator only lets public DNS names through in
 * production, but the URL parser accepts `;` and `,` in a host, and with
 * `LOBBYFORGE_PLUGIN_ALLOW_LOCAL_ORIGINS` the host is not re-checked — a
 * policy builder never writes anything that could end a directive.
 */
const CSP_ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;

export function isCspOrigin(value: string): boolean {
  return CSP_ORIGIN_RE.test(value);
}
