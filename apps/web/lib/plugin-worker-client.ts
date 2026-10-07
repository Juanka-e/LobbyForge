/**
 * Host-side client for the plugin worker (ADR-007).
 *
 * Marketplace plugins are sdk "sandbox-v1" bundles whose `server.js` runs
 * in a QuickJS VM inside the plugin-worker container — never in this
 * process. This client is the only bridge: token-authenticated RPC with a
 * hard timeout (a hung worker never hangs the web app), and a
 * worker-backed plugin object the routes use like an official plugin:
 *
 *  - `actionPolicies` come from the bundle's manifest.json, read from the
 *    web app's OWN copy of the installed files and validated here
 *    (sandbox-manifest.ts). The worker's describe answer must agree, but
 *    authorization never depends on what the worker (or plugin code) says.
 *  - `validateAction`, `migrateState` and `projectState` exist only when
 *    server.js defines them, so a plugin without a migrator costs no RPC on
 *    reads, and one without a projection is known to be public.
 *  - A reducer that returns its input state (a refused action) is reported
 *    by the worker as `unchanged`; handleAction then returns the SAME state
 *    object, so the actions route records nothing (no roster join, no audit).
 *
 * The plugin sees plain data only: `ctx` = { players, now, random(),
 * locale, sessionId, serverId, hostId, actorId }. No storage in sandbox v1.
 */
import { createHmac } from 'node:crypto';
import type { GamePluginActionPolicy, GamePluginContext, RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';
import { pluginInstallDir, readInstalledSandboxManifest } from './plugin-install-layout';
import { SANDBOX_SDK } from './sandbox-manifest';

/**
 * Scoped plugin-storage capability: HMAC(serverId|pluginId|expiry) over
 * LOBBYFORGE_PLUGIN_STORAGE_TOKEN, verified by /api/internal/plugin-storage.
 * Not used by sandbox v1 (plugins have no storage and the worker makes no
 * outbound calls); kept for that endpoint until a host-mediated storage
 * effect replaces it.
 */
const CAPABILITY_TTL_SECONDS = 120;

export function mintStorageCapability(
  serverId: string,
  pluginId: string,
  secret: string,
  nowMs = Date.now()
): string {
  const expiry = Math.floor(nowMs / 1000) + CAPABILITY_TTL_SECONDS;
  const mac = createHmac('sha256', secret).update(`${serverId}|${pluginId}|${expiry}`).digest('base64url');
  return `${expiry}.${mac}`;
}

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

/** The exact bundle a request targets: the version recorded as active and its digest. */
export interface WorkerBundleRef {
  pluginId: string;
  version: string;
  digest: string;
}

export interface WorkerPluginInfo {
  id: string;
  /** manifest.json `name`. */
  name: string;
  /** The INSTALLED (active) version — the folder the worker runs. */
  version: string;
  /** Digest of that folder (plugin-install-layout.ts computeBundleDigest). */
  digest: string;
  sdk: typeof SANDBOX_SDK;
  /** From manifest.json (validated by the web app), same shape as official plugins. */
  actionPolicies: Record<string, GamePluginActionPolicy>;
  minPlayers?: number;
  maxPlayers?: number;
  locales: string[];
  /** The bundle ships ui/index.html for the sandboxed iframe. */
  ui: boolean;
  /** manifest.json `requiresVoiceRoom`: players must be in the activity's voice room. */
  requiresVoiceRoom?: boolean;
  /** Which optional functions server.js defines (reported by the worker). */
  hasValidateAction: boolean;
  hasProjection: boolean;
  hasMigrateState: boolean;
}

/**
 * What projectState gets as `ctx` on a read. Nothing that differs between
 * the REST, SSE and WebSocket paths: no players, no locale (the gateway
 * knows neither), no random draws.
 */
export interface SandboxReadContext {
  sessionId: string;
  serverId: string;
  hostUserId: string | null;
  now?: number;
}

/**
 * A worker-backed plugin as stored in the dynamic registry. At runtime
 * `validateAction` returns a Promise (an RPC): the actions route awaits it.
 */
export type WorkerBackedPlugin = RegisteredGamePlugin & {
  __workerBacked: true;
  sdk: typeof SANDBOX_SDK;
  ui: boolean;
  /** server.js defines projectState: viewers get a per-viewer slice. Without it the state is public. */
  hasProjection: boolean;
  bundle: { version: string; digest: string };
  projectState?: (state: unknown, viewerUserId: string, ctx: SandboxReadContext) => Promise<unknown>;
};

export function isWorkerBackedPlugin(plugin: RegisteredGamePlugin | null | undefined): plugin is WorkerBackedPlugin {
  return !!plugin && (plugin as { __workerBacked?: unknown }).__workerBacked === true;
}

/** Key-sorted JSON, to compare two parsed manifests' policies. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Load exactly `ref`: read and validate its manifest from the install
 * directory, have the worker load that version + digest and report which
 * functions server.js defines, and check that both agree. The worker
 * refuses a missing version or a digest mismatch; it never picks a version.
 */
export async function describeWorkerPlugin(ref: WorkerBundleRef, root: string = pluginInstallDir()): Promise<WorkerPluginInfo> {
  const manifest = readInstalledSandboxManifest(root, ref.pluginId, ref.version);
  const { plugin } = await workerRpc<{ plugin?: Record<string, unknown> }>({
    op: 'describe',
    pluginId: ref.pluginId,
    version: ref.version,
    digest: ref.digest,
  });
  if (!plugin || plugin.id !== ref.pluginId) {
    throw new Error(`Bundle manifest id "${String(plugin?.id)}" does not match plugin id "${ref.pluginId}"`);
  }
  if (plugin.version !== ref.version || plugin.sdk !== SANDBOX_SDK) {
    throw new Error(`The plugin-worker loaded a different bundle than ${ref.pluginId}@${ref.version}`);
  }
  if (stableJson(plugin.actionPolicies) !== stableJson(manifest.actionPolicies)) {
    throw new Error(`The plugin-worker reports different action policies for ${ref.pluginId}@${ref.version} than its manifest.json`);
  }
  const info: WorkerPluginInfo = {
    id: ref.pluginId,
    name: manifest.name,
    version: ref.version,
    digest: ref.digest,
    sdk: SANDBOX_SDK,
    actionPolicies: manifest.actionPolicies,
    locales: manifest.locales,
    ui: manifest.ui,
    hasValidateAction: plugin.hasValidateAction === true,
    hasProjection: plugin.hasProjection === true,
    hasMigrateState: plugin.hasMigrateState === true,
  };
  if (manifest.minPlayers !== undefined) info.minPlayers = manifest.minPlayers;
  if (manifest.maxPlayers !== undefined) info.maxPlayers = manifest.maxPlayers;
  if (manifest.requiresVoiceRoom !== undefined) info.requiresVoiceRoom = manifest.requiresVoiceRoom;
  return info;
}

/** Scope attached (non-enumerably) by buildHttpPluginContext. */
interface CtxScope {
  serverId?: string;
  pluginId?: string;
}

/** Per-call facts the sandbox ctx carries beyond what GamePluginContext has. */
export interface SandboxCallScope {
  sessionId?: string;
  /** The session's host (game_sessions.created_by). */
  hostUserId?: string | null;
  locale?: string;
  /** One clock for the call (and its CAS retries). */
  now?: number;
}

/**
 * Attach the session id, host, locale and clock to a host-built ctx for the
 * worker envelope. Non-enumerable, invisible to official plugins.
 */
export function attachSandboxScope<T extends GamePluginContext>(ctx: T, scope: SandboxCallScope): T {
  Object.defineProperty(ctx, '__lfSandbox', { value: { ...scope }, enumerable: false, writable: false, configurable: true });
  return ctx;
}

function extractEnvelope(ctx: GamePluginContext, opts: { hostDefaultsToActor: boolean }) {
  const scope = (ctx as { __lfScope?: CtxScope }).__lfScope ?? {};
  const extra = (ctx as { __lfSandbox?: SandboxCallScope }).__lfSandbox ?? {};
  const players = ctx.players.list().map((id) => {
    const player = ctx.players.get(id);
    return { id, name: player?.name ?? id };
  });
  const hostId =
    extra.hostUserId !== undefined ? extra.hostUserId : opts.hostDefaultsToActor ? ctx.actorUserId : null;
  return {
    actorId: ctx.actorUserId,
    players,
    now: typeof extra.now === 'number' ? extra.now : Date.now(),
    locale: extra.locale ?? 'en',
    sessionId: extra.sessionId ?? '',
    serverId: scope.serverId ?? '',
    hostId,
  };
}

/**
 * Build the worker-backed plugin object stored in the dynamic registry.
 * Its methods return Promises: the host awaits createInitialState /
 * handleAction (callCreateInitialState / callHandleAction), every
 * `migrateState` call site awaits it, and so do validateAction and the
 * projection (plugin-projection.ts). Every RPC names the exact version +
 * digest; the worker refuses anything else.
 */
export function buildWorkerPlugin(info: WorkerPluginInfo): WorkerBackedPlugin {
  const bundle = { pluginId: info.id, version: info.version, digest: info.digest };
  const playerConfig =
    info.minPlayers !== undefined || info.maxPlayers !== undefined
      ? { minPlayers: info.minPlayers, maxPlayers: info.maxPlayers }
      : undefined;
  // From the web app's own copy of manifest.json (never the worker's answer):
  // the host applies its voice rule to a marketplace plugin the same way.
  const catalog =
    playerConfig || info.requiresVoiceRoom !== undefined
      ? {
          ...(playerConfig ? { playerConfig } : {}),
          ...(info.requiresVoiceRoom !== undefined ? { requiresVoiceRoom: info.requiresVoiceRoom } : {}),
        }
      : undefined;
  const plugin = {
    manifest: {
      id: info.id,
      name: info.name,
      version: info.version,
      type: 'game' as const,
      minAppVersion: '0.0.0',
      permissions: [],
      locales: info.locales,
      entryClient: '',
      ...(catalog ? { catalog } : {}),
    },
    actionPolicies: info.actionPolicies,
    __workerBacked: true as const,
    sdk: info.sdk,
    ui: info.ui,
    hasProjection: info.hasProjection,
    bundle: { version: info.version, digest: info.digest },
    createInitialState: async (ctx: GamePluginContext): Promise<unknown> => {
      const { result } = await workerRpc<{ result: unknown }>({
        op: 'createInitialState',
        ...bundle,
        ctx: extractEnvelope(ctx, { hostDefaultsToActor: true }),
      });
      return result;
    },
    handleAction: async (ctx: GamePluginContext, state: unknown, action: unknown): Promise<unknown> => {
      const reply = await workerRpc<{ result?: unknown; unchanged?: boolean }>({
        op: 'handleAction',
        ...bundle,
        ctx: extractEnvelope(ctx, { hostDefaultsToActor: false }),
        state,
        action,
      });
      // The reducer returned its input: hand back the SAME object (refused).
      return reply.unchanged === true ? state : reply.result;
    },
    validateAction: info.hasValidateAction
      ? async (action: unknown): Promise<string | null> => {
          const { result } = await workerRpc<{ result: unknown }>({ op: 'validateAction', ...bundle, action });
          return typeof result === 'string' && result.length > 0 ? result : null;
        }
      : undefined,
    migrateState: info.hasMigrateState
      ? async (raw: unknown): Promise<unknown> => {
          const { result } = await workerRpc<{ result: unknown }>({ op: 'migrateState', ...bundle, raw });
          return result;
        }
      : undefined,
    projectState: info.hasProjection
      ? async (state: unknown, viewerUserId: string, ctx: SandboxReadContext): Promise<unknown> => {
          const { result } = await workerRpc<{ result: unknown }>({
            op: 'projectState',
            ...bundle,
            state,
            viewerId: viewerUserId,
            ctx: {
              sessionId: ctx.sessionId,
              serverId: ctx.serverId,
              hostId: ctx.hostUserId,
              now: ctx.now ?? Date.now(),
            },
          });
          return result;
        }
      : undefined,
    renderClient: () => null,
  };
  return plugin as unknown as WorkerBackedPlugin;
}
