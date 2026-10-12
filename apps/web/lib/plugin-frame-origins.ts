/**
 * The origins the app's own pages may frame for marketplace plugins whose UI
 * is their author's site (`ui: { url }`, docs/PLUGIN_UNLOCK_PLAN.md phase 2),
 * for the `frame-src` that `proxy.ts` sends.
 *
 * Read from the install root, like everything else about installed plugins:
 * every active plugin (`listActivePlugins`), its installed manifest, and the
 * approval on its active record — only an EFFECTIVE `uiUrl` counts (asked for
 * by the manifest AND approved by the instance owner, `effectiveApprovals`).
 * A URL on the instance's own address is left out (plugin-frame-target.ts).
 *
 * The middleware runs for every page, so the list is cached per process for
 * 30 s on `globalThis` (Next compiles this module into several chunks — the
 * middleware's and the routes' — each with its own module scope; one
 * process-wide holder lets the installer reset what the middleware reads).
 * An install resets it, so a newly approved site can be framed at once; the
 * TTL bounds how long another process keeps an old list. Fail closed: when
 * the install root cannot be read, no origin is added (the external UIs then
 * do not load; the plugins' own files are unaffected) and the read is tried
 * again after 5 s.
 *
 * Server-only (reads the file system). Granting `frame-src` lets the app's
 * pages frame that origin and nothing more: no script, style or connection
 * from it runs in the app, and the lobby frames it only for an activity of
 * that plugin, with the sandbox and message rules of PluginFrame.
 */
import { effectiveApprovals } from './plugin-approvals';
import { configuredAppOrigins, externalUiOrigin, isCspOrigin } from './plugin-frame-target';
import { listActivePlugins, pluginInstallDir } from './plugin-install-layout';
import { readInstalledManifestOrNull } from './plugin-ui-assets';

export const PLUGIN_FRAME_ORIGINS_TTL_MS = 30_000;
/** After a failed read: nothing is added, and the read is tried again this soon. */
export const PLUGIN_FRAME_ORIGINS_RETRY_MS = 5_000;

interface OriginsCache {
  origins: readonly string[];
  /** Epoch ms after which the list is read again (0: never read, or reset). */
  expires: number;
}

const CACHE_KEY = '__lobbyforgePluginFrameOrigins__';

function cache(): OriginsCache {
  const holder = globalThis as typeof globalThis & { [CACHE_KEY]?: OriginsCache };
  holder[CACHE_KEY] ??= { origins: [], expires: 0 };
  return holder[CACHE_KEY];
}

/**
 * The origins of every active plugin's effective external UI under `root`,
 * sorted and de-duplicated, minus any on `apps`' hosts. A plugin whose
 * bundle cannot be read contributes nothing; a root that cannot be listed
 * throws (the caller fails closed).
 */
export function readApprovedUiOrigins(root: string, apps: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const active of listActivePlugins(root)) {
    const manifest = readInstalledManifestOrNull(root, active.pluginId, active.version);
    if (!manifest || manifest.ui) continue;
    const uiUrl = effectiveApprovals(manifest, active.approved).uiUrl;
    const origin = uiUrl ? externalUiOrigin(uiUrl, apps) : null;
    if (origin && isCspOrigin(origin)) origins.add(origin);
  }
  return [...origins].sort();
}

/**
 * The origins to add to the pages' `frame-src`: the cached list (read again
 * when older than 30 s), minus any on `requestOrigin`'s host — a proxy may
 * serve the app under a name the configuration does not list.
 */
export function approvedPluginFrameOrigins(
  requestOrigin: string | null = null,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now()
): string[] {
  if (env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED !== 'true') return [];
  const state = cache();
  if (state.expires <= now) {
    try {
      state.origins = readApprovedUiOrigins(pluginInstallDir(env), configuredAppOrigins(env));
      state.expires = now + PLUGIN_FRAME_ORIGINS_TTL_MS;
    } catch (err) {
      console.error('[plugin-frame-origins] cannot read the install root:', JSON.stringify((err as Error).message));
      state.origins = [];
      state.expires = now + PLUGIN_FRAME_ORIGINS_RETRY_MS;
    }
  }
  if (!requestOrigin) return [...state.origins];
  return state.origins.filter((origin) => externalUiOrigin(origin, [requestOrigin]) !== null);
}

/** Forget the cached list: the next page reads the install root again. Called after an install. */
export function resetPluginFrameOrigins(): void {
  const state = cache();
  state.origins = [];
  state.expires = 0;
}
