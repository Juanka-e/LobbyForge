/**
 * Does an installed marketplace plugin have a UI the lobby can frame, and
 * where is it? (ADR-007; docs/PLUGIN_UNLOCK_PLAN.md phase 2.)
 *
 *  - `mode: "files"`: the plugin's own `ui/` files (`ui: true`), served by
 *    /api/plugin-ui/{id}/{version}/… into `<iframe sandbox="allow-scripts">`.
 *  - `mode: "external"`: the author's own site (`ui: { url }`), framed
 *    directly — only while the instance owner's approval of that URL is on
 *    the active record (`effectiveApprovals`), and never when the URL is on
 *    the instance's own address (plugin-frame-target.ts: the lobby frames it
 *    with `allow-same-origin`, which is safe only for another site).
 *
 * Server-only (reads the install root and the dynamic registry). The lobby
 * asks through GET /api/plugin-ui/{pluginId}; official plugins never have a
 * frame — they keep their compiled-in React panels.
 */
import type { RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';
import { effectiveApprovals } from './plugin-approvals';
import { appOrigins, configuredAppOrigins, externalUiOrigin, pluginFrameSrc } from './plugin-frame-target';
import { pluginInstallDir, readActivePointer } from './plugin-install-layout';
import { getPlugin } from './plugin-registry';
import { getDynamicPlugin } from './plugin-loader';
import { readInstalledManifestOrNull } from './plugin-ui-assets';

interface PluginFrameBase {
  pluginId: string;
  /** The ACTIVE version: the only one /api/plugin-ui serves. */
  version: string;
  /**
   * Whether the plugin projects its state per viewer (`projectState` in its
   * server.js). Without it every viewer receives the full state, and the
   * lobby says so.
   */
  hasProjection: boolean;
}

export type PluginFrameInfo =
  | (PluginFrameBase & {
      mode: 'files';
      /** The entry document under /api/plugin-ui. */
      src: string;
    })
  | (PluginFrameBase & {
      mode: 'external';
      /** The approved `ui.url`, framed as is. */
      src: string;
      /** Its origin: the only one whose messages the lobby accepts, and where it posts. */
      origin: string;
    });

/**
 * Whether a loaded marketplace plugin projects its state per viewer: the
 * plugin worker's `describe` reports `hasProjection` (server.js defines
 * `projectState`), carried on the worker-backed plugin object or its
 * manifest. Only an explicit `true` counts — a method that merely forwards
 * to the worker proves nothing — so the lobby errs towards warning.
 */
export function pluginHasProjection(plugin: RegisteredGamePlugin | null): boolean {
  if (!plugin) return false;
  const loose = plugin as unknown as { hasProjection?: unknown; manifest?: { hasProjection?: unknown } };
  return loose.hasProjection === true || loose.manifest?.hasProjection === true;
}

/**
 * The frame the lobby should show for `pluginId`, or null. `requestOrigin`
 * (the origin the request reached the app on) joins the configured public
 * origins in the own-address check.
 */
export function describePluginFrame(
  pluginId: string,
  env: Record<string, string | undefined> = process.env,
  requestOrigin: string | null = null
): PluginFrameInfo | null {
  if (env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED !== 'true') return null;
  if (getPlugin(pluginId)) return null;
  const root = pluginInstallDir(env);
  const active = readActivePointer(root, pluginId);
  if (!active) return null;
  // Read once: whether it has a UI, of which kind, and what it asks for.
  const manifest = readInstalledManifestOrNull(root, pluginId, active.version);
  if (!manifest) return null;
  const uiUrl = manifest.ui ? undefined : effectiveApprovals(manifest, active.approved).uiUrl;
  if (!manifest.ui && !uiUrl) return null;
  // Loaded through the worker: otherwise it cannot run, so there is no game to show.
  const plugin = getDynamicPlugin(pluginId);
  if (!plugin) return null;
  const base: PluginFrameBase = { pluginId, version: active.version, hasProjection: pluginHasProjection(plugin) };
  if (manifest.ui) return { ...base, mode: 'files', src: pluginFrameSrc(pluginId, active.version) };

  const origin = externalUiOrigin(uiUrl!, appOrigins([...configuredAppOrigins(env), requestOrigin]));
  if (!origin) {
    // The installer refuses this; a changed public origin can still get here.
    console.error(
      `[plugin-ui] ${pluginId}: not framing its ui.url, which is on this instance's own address:`,
      JSON.stringify(uiUrl)
    );
    return null;
  }
  return { ...base, mode: 'external', src: uiUrl!, origin };
}
