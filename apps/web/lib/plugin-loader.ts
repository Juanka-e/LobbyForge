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

  if (!existsSync(INSTALLED_DIR)) return;

  let entries: string[];
  try {
    entries = readdirSync(INSTALLED_DIR).filter((name) =>
      statSync(join(INSTALLED_DIR, name)).isDirectory()
    );
  } catch {
    return;
  }

  for (const pluginId of entries) {
    try {
      const loaded = await loadPluginFromDisk(pluginId);
      if (loaded) {
        dynamicPlugins.set(loaded.manifest.id, loaded);
        loadedPluginIds.push(loaded.manifest.id);
        console.info(`[plugin-loader] loaded dynamic plugin: ${loaded.manifest.id} v${loaded.manifest.version}`);
      }
    } catch (err) {
      console.error(`[plugin-loader] failed to load plugin "${pluginId}":`, (err as Error).message);
    }
  }
}

/**
 * Import a single plugin from its installed directory.
 * Expects `plugins/installed/<pluginId>/index.js` (ESM) exporting `{ plugin }`.
 */
async function loadPluginFromDisk(pluginId: string): Promise<RegisteredGamePlugin | null> {
  // Find the latest version directory (or the plugin root if no versioning).
  const pluginDir = join(INSTALLED_DIR, pluginId);
  let indexPath = join(pluginDir, 'index.js');

  // If there are version subdirectories, pick the newest by name.
  if (!existsSync(indexPath)) {
    const subdirs = readdirSync(pluginDir)
      .filter((d) => statSync(join(pluginDir, d)).isDirectory())
      .sort()
      .reverse();
    if (subdirs.length === 0) return null;
    indexPath = join(pluginDir, subdirs[0]!, 'index.js');
    if (!existsSync(indexPath)) return null;
  }

  const fileUrl = pathToFileURL(indexPath).href;
  const mod = await import(fileUrl);

  // Accept either `{ plugin }` or default export.
  const raw: unknown = mod?.plugin ?? mod?.default;
  if (!isValidGamePlugin(raw)) {
    console.warn(`[plugin-loader] plugin "${pluginId}" failed shape validation`);
    return null;
  }

  const gamePlugin = raw as GamePlugin<unknown, unknown, unknown>;

  // Verify the manifest id matches the directory name.
  if (gamePlugin.manifest.id !== pluginId) {
    console.warn(
      `[plugin-loader] plugin "${pluginId}" manifest.id mismatch: "${gamePlugin.manifest.id}"`
    );
    return null;
  }

  return registerGamePlugin(gamePlugin);
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
 * Reload a single plugin after the install API extracts a new version.
 * Uses a cache-busting query string on the import URL so ESM `import()`
 * always picks up the new files on disk (ESM has no `require.cache`).
 */
export async function reloadDynamicPlugin(pluginId: string): Promise<boolean> {
  try {
    // Force re-import by busting any internal ESM cache via a unique URL.
    const pluginDir = join(INSTALLED_DIR, pluginId);
    let indexPath = join(pluginDir, 'index.js');
    if (!existsSync(indexPath)) {
      const subdirs = existsSync(pluginDir)
        ? readdirSync(pluginDir).filter((d) => statSync(join(pluginDir, d)).isDirectory()).sort().reverse()
        : [];
      if (subdirs.length === 0) return false;
      indexPath = join(pluginDir, subdirs[0]!, 'index.js');
      if (!existsSync(indexPath)) return false;
    }

    // Cache-bust: append a unique version query so Node's ESM loader treats
    // this as a new module (ESM doesn't have require.cache to clear).
    const fileUrl = pathToFileURL(indexPath).href + `?v=${Date.now()}`;
    const mod = await import(fileUrl);
    const raw: unknown = mod?.plugin ?? mod?.default;
    if (!isValidGamePlugin(raw)) {
      console.warn(`[plugin-loader] reload shape validation failed for "${pluginId}"`);
      return false;
    }
    const gamePlugin = raw as GamePlugin<unknown, unknown, unknown>;
    if (gamePlugin.manifest.id !== pluginId) {
      console.warn(`[plugin-loader] reload id mismatch: "${pluginId}" vs "${gamePlugin.manifest.id}"`);
      return false;
    }
    const registered = registerGamePlugin(gamePlugin);
    dynamicPlugins.set(registered.manifest.id, registered);
    if (!loadedPluginIds.includes(registered.manifest.id)) {
      loadedPluginIds.push(registered.manifest.id);
    }
    console.info(`[plugin-loader] reloaded plugin: ${registered.manifest.id}`);
    return true;
  } catch (err) {
    console.error(`[plugin-loader] reload failed for "${pluginId}":`, (err as Error).message);
  }
  return false;
}
