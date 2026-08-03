/**
 * Server-side plugin registry — compiled-in + dynamically-loaded plugins.
 *
 * This module is SERVER-ONLY (imports plugin-loader.ts which uses Node fs).
 * API routes import `getPluginServer` / `listPluginSummariesServer` to
 * resolve both compiled-in and marketplace-installed plugins.
 *
 * Client components import `getPlugin` from `plugin-registry.ts` (compiled
 * only) to avoid pulling Node APIs into the browser bundle.
 */
import { PLUGINS, listPluginSummaries, type PluginSummary } from './plugin-registry';
import type { RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';
import {
  getDynamicPlugin,
  listDynamicPluginIds,
  warmInstalledPlugins,
} from './plugin-loader';

/**
 * Look up a plugin by id — checks the compiled-in list first, then
 * falls back to the dynamically-loaded map. Returns null if not found.
 */
export function getPluginServer(id: string): RegisteredGamePlugin | null {
  const compiled = PLUGINS.find((p) => p.manifest.id === id);
  if (compiled) return compiled;
  return getDynamicPlugin(id);
}

/**
 * List all plugin summaries — compiled-in + dynamically-loaded.
 */
export function listPluginSummariesServer(): PluginSummary[] {
  const compiled = listPluginSummaries();
  const seen = new Set(compiled.map((p) => p.id));
  for (const id of listDynamicPluginIds()) {
    const dyn = getDynamicPlugin(id);
    if (dyn && !seen.has(dyn.manifest.id)) {
      compiled.push({
        id: dyn.manifest.id,
        name: dyn.manifest.name,
        version: dyn.manifest.version,
        type: dyn.manifest.type,
        catalog: dyn.manifest.catalog ?? null,
      });
    }
  }
  return compiled;
}

/**
 * Pre-warm dynamically-loaded plugins at boot. Call from instrumentation.
 */
export async function warmDynamicPlugins(): Promise<void> {
  await warmInstalledPlugins();
}
