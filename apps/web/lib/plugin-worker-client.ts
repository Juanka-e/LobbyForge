/**
 * Host-side client for the isolated plugin-worker (LF-SEC-010).
 *
 * When dynamic plugins are enabled, marketplace code runs in the
 * plugin-worker CONTAINER — never in-process. This client is the only
 * bridge: RPC calls with a shared token, hard timeouts (a hung worker
 * can never hang the web app) and a worker-backed plugin object whose
 * methods transparently package the host ctx into the SNAPSHOT
 * envelope the worker rebuilds on its side.
 */
import type { GamePluginContext, RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';

/** Dynamic execution is only allowed through the isolated worker. */
export function workerRuntimeConfigured(): boolean {
  return (
    process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED === 'true' &&
    !!process.env.LOBBYFORGE_PLUGIN_WORKER_URL
  );
}

const RPC_TIMEOUT_MS = 10_000;

async function workerRpc<T>(payload: Record<string, unknown>): Promise<T> {
  const base = (process.env.LOBBYFORGE_PLUGIN_WORKER_URL || '').replace(/\/$/, '');
  const token = process.env.LOBBYFORGE_PLUGIN_WORKER_TOKEN || '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lf-worker-token': token },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(detail.error ?? `plugin-worker HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface WorkerPluginInfo {
  id: string;
  name: string;
  version: string | null;
}

export async function listWorkerPlugins(): Promise<WorkerPluginInfo[]> {
  const { plugins } = await workerRpc<{ plugins: WorkerPluginInfo[] }>({ op: 'list' });
  return plugins;
}

/** Scope attached (non-enumerably) to host-built ctx objects. */
interface CtxScope {
  serverId?: string;
  pluginId?: string;
}

function extractEnvelope(ctx: GamePluginContext, pluginId: string) {
  const scope = (ctx as { __lfScope?: CtxScope }).__lfScope ?? {};
  const players = ctx.players
    .list()
    .map((id) => ctx.players.get(id) ?? { id, name: id });
  return {
    actorUserId: ctx.actorUserId,
    players,
    voiceParticipants: ctx.voice.getParticipants(),
    serverId: scope.serverId ?? '',
    pluginId: scope.pluginId ?? pluginId,
  };
}

/**
 * Build the worker-backed plugin object stored in the dynamic registry.
 * Its methods return Promises — the host call sites already await the
 * wrapping functions (callCreateInitialState/callHandleAction), which
 * absorb them.
 */
export function buildWorkerPlugin(info: WorkerPluginInfo): RegisteredGamePlugin {
  const plugin = {
    manifest: {
      id: info.id,
      name: info.name,
      version: info.version ?? '0.0.0',
      type: 'game' as const,
      minAppVersion: '0.0.0',
      permissions: [],
      locales: ['en'],
      entryClient: './client.js',
    },
    /** Marker — distinguishes worker-backed entries (tests, debugging). */
    __workerBacked: true,
    createInitialState: async (ctx: GamePluginContext): Promise<unknown> => {
      const { result } = await workerRpc<{ result: unknown }>({
        op: 'createInitialState',
        pluginId: info.id,
        ctx: extractEnvelope(ctx, info.id),
      });
      return result;
    },
    handleAction: async (
      ctx: GamePluginContext,
      state: unknown,
      action: unknown
    ): Promise<unknown> => {
      const { result } = await workerRpc<{ result: unknown }>({
        op: 'handleAction',
        pluginId: info.id,
        ctx: extractEnvelope(ctx, info.id),
        state,
        action,
      });
      return result;
    },
    migrateState: async (raw: unknown): Promise<unknown> => {
      const { result } = await workerRpc<{ result: unknown }>({
        op: 'migrateState',
        pluginId: info.id,
        raw,
      });
      return result;
    },
    renderClient: () => null,
  };
  return plugin as unknown as RegisteredGamePlugin;
}
