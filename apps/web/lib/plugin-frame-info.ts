/**
 * Does an installed marketplace plugin have a sandboxed UI the lobby can
 * frame, and which version does the asset route serve? (ADR-007.)
 *
 * Server-only (reads the install root and the dynamic registry). The lobby
 * asks through GET /api/plugin-ui/{pluginId}; official plugins never have a
 * frame — they keep their compiled-in React panels.
 */
import type { RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';
import { pluginInstallDir, readActivePointer } from './plugin-install-layout';
import { getPlugin } from './plugin-registry';
import { getDynamicPlugin } from './plugin-loader';
import { installedVersionDeclaresUi } from './plugin-ui-assets';

export interface PluginFrameInfo {
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

export function describePluginFrame(
  pluginId: string,
  env: Record<string, string | undefined> = process.env
): PluginFrameInfo | null {
  if (env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED !== 'true') return null;
  if (getPlugin(pluginId)) return null;
  const root = pluginInstallDir(env);
  const active = readActivePointer(root, pluginId);
  if (!active) return null;
  if (!installedVersionDeclaresUi(root, pluginId, active.version)) return null;
  // Loaded through the worker: otherwise it cannot run, so there is no game to show.
  const plugin = getDynamicPlugin(pluginId);
  if (!plugin) return null;
  return { pluginId, version: active.version, hasProjection: pluginHasProjection(plugin) };
}
