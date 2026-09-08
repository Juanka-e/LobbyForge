/**
 * Dynamic plugin loader — resolves marketplace-installed plugins from disk.
 *
 * Approved marketplace plugins are downloaded + extracted to
 * `plugins/installed/<pluginId>/<version>/` by the install API. This module
 * pre-warms them at boot by walking the directory and `import()`-ing each
 * `index.js`, then validates the shape and stores the result in an in-memory
 * map. The hot path (getPlugin) stays synchronous because the map is
 * populated before the first request.
 *
 * Bundle contract:
 *   - The plugin directory contains an `index.js` (ESM) that exports
 *     `plugin: GamePlugin` (named export).
 *   - The bundle externalizes `@lobbyforge/plugin-sdk` and `react` — the
 *     host provides them (same as workspace packages today).
 *   - The manifest's `id` must match the directory's `<pluginId>`.
 *
 * Security:
 *   - Only plugins whose `plugin_catalog.review_status === 'approved'` are
 *     loaded. The install API enforces this before extracting.
 *   - The imported object is shape-validated before admission.
 *   - `handleAction` / `createInitialState` run inside try/catch + a CPU
 *     budget in plugin-context.ts (the safety net added in Faz 4.4).
 *   - This is NOT a sandbox — untrusted code still runs in-process. The
 *     trust model relies on review_status + trust_level + admin control.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  registerGamePlugin,
  type RegisteredGamePlugin,
  type GamePlugin,
} from '@lobbyforge/plugin-sdk';
import {
  buildWorkerPlugin,
  listWorkerPlugins,
  workerRuntimeConfigured,
} from './plugin-worker-client';

const INSTALLED_DIR = resolve(process.cwd(), 'plugins', 'installed');

/** In-memory map of dynamically-loaded plugins, keyed by manifest.id. */
const dynamicPlugins = new Map<string, RegisteredGamePlugin>();

/** True once warmInstalledPlugins() has completed (or found nothing). */
let warmed = false;

/** The list of pluginIds that were successfully loaded at warm time. */
const loadedPluginIds: string[] = [];

/**
 * Walk `plugins/installed/` and `import()` each plugin's `index.js`.
 * Called once at boot (from instrumentation or the first server request).
 * Safe to call multiple times — it skips if already warmed.
 */
export async function warmInstalledPlugins(): Promise<void> {
  if (warmed) return;
  warmed = true;

  // Dynamic plugin execution is disabled by default. Since LF-SEC-010
  // the ONLY enabled mode is the ISOLATED plugin-worker container —
  // the flag alone (without LOBBYFORGE_PLUGIN_WORKER_URL) loads
  // NOTHING (fail closed), and in-process import of third-party code
  // is no longer possible from this path at all.
  if (process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED !== 'true') {
    return;
  }
  if (!workerRuntimeConfigured()) {
    console.warn(
      '[plugin-loader] LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED=true but LOBBYFORGE_PLUGIN_WORKER_URL is not set — refusing to load anything (the isolated worker is mandatory).'
    );
    return;
  }

  try {
    const plugins = await listWorkerPlugins();
    for (const info of plugins) {
      dynamicPlugins.set(info.id, buildWorkerPlugin(info));
      loadedPluginIds.push(info.id);
    }
    if (plugins.length > 0) {
      console.info(`[plugin-loader] ${plugins.length} plugin(s) loaded via the isolated worker`);
    }
  } catch (err) {
    // Fail closed — the worker being down means no dynamic plugins.
    console.error('[plugin-loader] plugin-worker unreachable:', (err as Error).message);
    return;
  }
}

/** Validate that the imported object has the required GamePlugin shape. */
function isValidGamePlugin(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  const manifest = o.manifest as Record<string, unknown> | undefined;
  if (!manifest || typeof manifest.id !== 'string' || typeof manifest.name !== 'string') {
    return false;
  }
  return (
    typeof o.createInitialState === 'function' &&
    typeof o.handleAction === 'function' &&
    typeof o.renderClient === 'function'
  );
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
 * Refresh a single plugin after the install API extracts a new version.
 * In worker mode the WORKER owns loading — we ask it for its current
 * plugin list and sync our registry entry from it.
 */
export async function reloadDynamicPlugin(pluginId: string): Promise<boolean> {
  if (process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED !== 'true') {
    console.warn('[plugin-loader] dynamic plugins are disabled (LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED != true)');
    return false;
  }
  if (!workerRuntimeConfigured()) {
    console.warn('[plugin-loader] reload refused: the isolated plugin-worker is mandatory');
    return false;
  }
  try {
    const plugins = await listWorkerPlugins();
    const info = plugins.find((p) => p.id === pluginId);
    if (!info) return false;
    dynamicPlugins.set(info.id, buildWorkerPlugin(info));
    if (!loadedPluginIds.includes(info.id)) loadedPluginIds.push(info.id);
    return true;
  } catch (err) {
    console.error(`[plugin-loader] reload via worker failed for "${pluginId}":`, (err as Error).message);
    return false;
  }
}
