/**
 * Plugin registry — the compiled-in list of plugins the web app knows about.
 *
 * M16 shipped a single plugin — `@lobbyforge/quiz` — which served as the
 * "dummy plugin" for the Aşama 3 success criterion. M17 registers
 * `@lobbyforge/hushle` as the first real-game plugin (Aşama 4 — Hushle
 * MVP). The other official plugins (vampire-village, watch-party) live
 * in `plugins/*` and are added here as they become activity-ready.
 *
 * The registry is intentionally a static array (not dynamic import).
 * Dynamic loading + hot-reload is M18+ scope; the trade-off is that
 * adding a new plugin requires a code change + redeploy today, which
 * is fine for the small plugin set we have.
 *
 * The `PluginId` type is the union of `manifest.id` values of the
 * registered plugins — TypeScript can use it to narrow route params
 * and audit-log metadata.
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

export type PluginId = (typeof PLUGINS)[number]['manifest']['id'];

/**
 * Look up a registered plugin by its `manifest.id`. Returns null if
 * no plugin with that id is registered — callers map this to a 404.
 */
export function getPlugin(id: string): RegisteredGamePlugin | null {
  return PLUGINS.find((p) => p.manifest.id === id) ?? null;
}

/**
 * Project a slim `{id, name}` view for the picker UI. The full plugin
 * (with its `createInitialState` and `handleAction`) is never sent to
 * the client.
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
