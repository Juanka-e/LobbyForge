/**
 * Plugin registry — compiled-in plugins.
 *
 * The compiled-in `PLUGINS` array covers the officially-bundled games
 * (Hushle, Quiz). Dynamically-loaded marketplace plugins are resolved by
 * `getPluginServer` (server-only, in plugin-server-registry.ts) which
 * checks this list first then falls back to the on-disk loader.
 *
 * This module is client-safe (no Node fs/child_process imports).
 */
import { hushlePlugin } from '@lobbyforge/hushle';
import { quizPlugin } from '@lobbyforge/quiz';
import { registerGamePlugin, type RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';
import type { PluginCatalogMetadata } from '@lobbyforge/plugin-sdk';

export const PLUGINS: readonly RegisteredGamePlugin[] = [
  registerGamePlugin(hushlePlugin),
  registerGamePlugin(quizPlugin),
] as const;

export type PluginSummary = {
  id: string;
  name: string;
  version: string;
  type: 'game' | 'activity' | 'utility';
  catalog: PluginCatalogMetadata | null;
};

/**
 * Look up a compiled-in plugin by its `manifest.id`. Client-safe — does
 * NOT resolve dynamically-loaded marketplace plugins (those need Node fs).
 * Server routes should use `getPluginServer` from plugin-server-registry.ts
 * for the full (compiled + dynamic) lookup.
 */
export function getPlugin(id: string): RegisteredGamePlugin | null {
  return PLUGINS.find((p) => p.manifest.id === id) ?? null;
}

/**
 * Project a slim `{id, name}` view for the picker UI.
 */
export function listPluginSummaries(): PluginSummary[] {
  return PLUGINS.map((p) => ({
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version,
    type: p.manifest.type,
    catalog: p.manifest.catalog ?? null,
  }));
}
