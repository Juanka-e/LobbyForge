/**
 * The per-viewer state every read path sends (LF-001, ADR-007): the GET
 * route, the SSE snapshot and state events, the actions response and the
 * gateway's internal projection endpoint all go through
 * `projectStateForViewer`.
 *
 *  - Official (compiled-in) plugins: the canonical core projector
 *    (projectActivityState), as before.
 *  - Marketplace (worker-backed, sandbox-v1) plugins: the plugin's own
 *    `projectState(state, viewerId, ctx)`, run in the plugin worker. A
 *    plugin without one has public state by design (`hasProjection: false`
 *    — the lobby warns). A failed projection THROWS: callers fail closed
 *    and never fall back to the unprojected state.
 *  - No plugin at all (a marketplace plugin that is not loaded, e.g. the
 *    worker was down at boot): its rules are unknown, so the state is
 *    withheld (`null`) rather than sent unfiltered.
 */
import { projectActivityState } from './activity-projection';
import { isWorkerBackedPlugin, type SandboxReadContext } from './plugin-worker-client';
import type { RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';

export type { SandboxReadContext };

/**
 * Projections already computed in this request (or SSE stream), keyed by
 * state revision + viewer, so one state is projected once per viewer.
 */
export class ProjectionCache {
  private readonly entries = new Map<string, Promise<unknown>>();
  constructor(private readonly maxEntries = 8) {}

  getOrCompute(key: string, compute: () => Promise<unknown>): Promise<unknown> {
    const hit = this.entries.get(key);
    if (hit) return hit;
    const pending = compute();
    this.entries.set(key, pending);
    // A failure is not remembered: the next read tries again.
    pending.catch(() => {
      if (this.entries.get(key) === pending) this.entries.delete(key);
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return pending;
  }
}

export interface ViewerProjectionInput {
  plugin: RegisteredGamePlugin | null;
  pluginId: string;
  /** Already migrated. */
  state: unknown;
  viewerUserId: string;
  ctx: SandboxReadContext;
  /** With `revision`, reuses a projection of the same state for the same viewer. */
  cache?: ProjectionCache;
  revision?: number | string | null;
}

export async function projectStateForViewer(input: ViewerProjectionInput): Promise<unknown> {
  const { plugin, pluginId, state, viewerUserId } = input;
  if (!plugin) return null;
  if (!isWorkerBackedPlugin(plugin)) return projectActivityState(state, pluginId, viewerUserId);
  const projectState = plugin.projectState;
  if (!projectState) return state;
  const compute = () => projectState(state, viewerUserId, input.ctx);
  if (input.cache && input.revision !== undefined && input.revision !== null) {
    return input.cache.getOrCompute(`${input.revision}|${viewerUserId}`, compute);
  }
  return compute();
}

/** Whether viewers of this plugin get a per-viewer slice (official plugins always do, via core). */
export function pluginProjectsState(plugin: RegisteredGamePlugin | null): boolean {
  if (!plugin) return false;
  return isWorkerBackedPlugin(plugin) ? plugin.hasProjection : true;
}

const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * The viewer's language for the sandbox ctx: the saved `lf_locale` choice,
 * else the first Accept-Language tag, else English. A hint only — the
 * plugin picks from its own locales.
 */
export function sandboxLocaleFor(req: Request): string {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== 'lf_locale') continue;
    try {
      const value = decodeURIComponent(rest.join('=')).trim();
      if (LOCALE_RE.test(value)) return value;
    } catch {
      /* ignore a malformed cookie */
    }
  }
  const first = (req.headers.get('accept-language') ?? '').split(',')[0]?.split(';')[0]?.trim() ?? '';
  const normalized = first.replace(/^([A-Za-z]{2,3})/, (lang) => lang.toLowerCase());
  return LOCALE_RE.test(normalized) ? normalized : 'en';
}
