/**
 * Dynamic plugin loader — the registry of marketplace-installed plugins.
 *
 * Approved marketplace bundles are extracted by the install API into the
 * shared install root (`plugin-install-layout.ts`):
 * `<root>/<pluginId>/<version>/` plus `<root>/<pluginId>/active.json`, the
 * record of which version is active and the digest of its files.
 *
 * This module never imports plugin code. At boot it reads the active
 * records and asks the isolated plugin-worker to load each exact
 * version + digest; the worker-backed plugin objects it gets back are kept
 * in an in-memory map so the hot path (getPlugin) stays synchronous.
 *
 * Bundle contract (docs/EXTENDING.md §3.5):
 *   - `index.js` (ESM) at the bundle root, exporting `plugin` or `default`.
 *   - Self-contained: the worker provides no packages to bundles, so
 *     `react` and `@lobbyforge/plugin-sdk` are bundled in, not external.
 *   - `manifest.id` equals the catalog `pluginId`.
 *
 * Security:
 *   - Disabled unless LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED=true, and then only
 *     through the worker (LOBBYFORGE_PLUGIN_WORKER_URL) — fail closed.
 *   - Only approved, digest-pinned catalog entries are installed (install
 *     API), and the worker re-verifies the files' digest before running them.
 *   - ADR-001: the worker isolates reviewed code, not hostile code.
 */
import type { RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';
import {
  buildWorkerPlugin,
  describeWorkerPlugin,
  workerRuntimeConfigured,
  type WorkerPluginInfo,
} from './plugin-worker-client';
import { listActivePlugins, pluginInstallDir, readActivePointer } from './plugin-install-layout';

/** In-memory map of dynamically-loaded plugins, keyed by manifest.id. */
const dynamicPlugins = new Map<string, RegisteredGamePlugin>();

/** True once warmInstalledPlugins() has completed (or found nothing). */
let warmed = false;

/** The list of pluginIds that were successfully loaded. */
const loadedPluginIds: string[] = [];

function dynamicPluginsEnabled(): boolean {
  return process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED === 'true';
}

/**
 * Load every plugin that has an active record, through the worker.
 * Called once at boot (from instrumentation). Safe to call multiple
 * times — it skips if already warmed.
 */
export async function warmInstalledPlugins(): Promise<void> {
  if (warmed) return;
  warmed = true;

  // Dynamic plugin execution is disabled by default. Since LF-SEC-010
  // the ONLY enabled mode is the ISOLATED plugin-worker container —
  // the flag alone (without LOBBYFORGE_PLUGIN_WORKER_URL) loads
  // NOTHING (fail closed), and in-process import of third-party code
  // is no longer possible from this path at all.
  if (!dynamicPluginsEnabled()) {
    return;
  }
  if (!workerRuntimeConfigured()) {
    console.warn(
      '[plugin-loader] LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED=true but LOBBYFORGE_PLUGIN_WORKER_URL is not set — refusing to load anything (the isolated worker is mandatory).'
    );
    return;
  }

  let active: ReturnType<typeof listActivePlugins>;
  try {
    active = listActivePlugins(pluginInstallDir());
  } catch (err) {
    console.error('[plugin-loader] cannot read the plugin install directory:', (err as Error).message);
    return;
  }
  let count = 0;
  for (const ref of active) {
    try {
      registerDynamicPlugin(await describeWorkerPlugin(ref));
      count += 1;
    } catch (err) {
      // Fail closed per plugin — an unreachable worker means none load.
      console.error(
        `[plugin-loader] ${ref.pluginId}@${ref.version} not loaded:`,
        (err as Error).message
      );
    }
  }
  if (count > 0) {
    console.info(`[plugin-loader] ${count} plugin(s) loaded via the isolated worker`);
  }
}

/** Put (or replace) a worker-described plugin in the registry. */
export function registerDynamicPlugin(info: WorkerPluginInfo): void {
  dynamicPlugins.set(info.id, buildWorkerPlugin(info));
  if (!loadedPluginIds.includes(info.id)) loadedPluginIds.push(info.id);
}

/**
 * Look up a dynamically-loaded plugin by id. Returns null if not loaded.
 * The caller (plugin-registry getPlugin) checks the compiled-in list first,
 * then falls back to this.
 */
export function getDynamicPlugin(id: string): RegisteredGamePlugin | null {
  return dynamicPlugins.get(id) ?? null;
}

/** List all dynamically-loaded plugin ids (for diagnostics/logging). */
export function listDynamicPluginIds(): string[] {
  return [...loadedPluginIds];
}

/**
 * Re-read one plugin's active record and reload exactly that version
 * through the worker. The installer registers directly after an
 * activation; this is for callers that only know the id.
 */
export async function reloadDynamicPlugin(pluginId: string): Promise<boolean> {
  if (!dynamicPluginsEnabled()) {
    console.warn('[plugin-loader] dynamic plugins are disabled (LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED != true)');
    return false;
  }
  if (!workerRuntimeConfigured()) {
    console.warn('[plugin-loader] reload refused: the isolated plugin-worker is mandatory');
    return false;
  }
  try {
    const ref = readActivePointer(pluginInstallDir(), pluginId);
    if (!ref) return false;
    registerDynamicPlugin(await describeWorkerPlugin(ref));
    return true;
  } catch (err) {
    console.error(`[plugin-loader] reload via worker failed for "${pluginId}":`, (err as Error).message);
    return false;
  }
}
