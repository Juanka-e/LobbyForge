/**
 * Plugin worker — the ISOLATED runtime for marketplace (dynamic) plugins
 * (LF-SEC-010 long-term fix).
 *
 * Third-party plugin code never runs in the web process anymore. This
 * service is a separate container with:
 *   - NO host secrets in its environment (the compose service gets only
 *     the RPC token, the host origin and the storage-capability token);
 *   - a READ-ONLY mount of the installed-plugins directory;
 *   - memory/pid caps, dropped capabilities, no-new-privileges and an
 *     internal-only network (never behind the public edge).
 *
 * A frozen/hung worker cannot touch the web app: the host client times
 * out, this service's healthcheck fails and compose restarts it.
 *
 * RPC surface (POST /rpc, header `x-lf-worker-token`):
 *   { op: 'list' }
 *   { op: 'createInitialState', pluginId, ctx, ... }
 *   { op: 'handleAction', pluginId, ctx, state, action }
 *   { op: 'migrateState', pluginId, raw }
 *
 * The ctx envelope carries ONLY snapshot data (actorUserId, players,
 * voiceParticipants). Write-side capabilities (`ctx.storage.*`) are
 * proxied back to the host over the internal plugin-storage endpoint —
 * the worker holds no database credentials, so a compromised plugin can
 * at worst touch its OWN (serverId, pluginId) storage keyspace.
 */
import * as http from 'node:http';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GamePlugin, GamePluginContext } from '@lobbyforge/plugin-sdk';

const PORT = parseInt(process.env.PLUGIN_WORKER_PORT || '7101', 10);
const HOST = process.env.PLUGIN_WORKER_HOST || '0.0.0.0';

// Read the runtime knobs LAZILY (tests set process.env after import).
const pluginsDir = () => resolve(process.env.PLUGINS_DIR || './plugins/installed');
const rpcToken = () => process.env.PLUGIN_WORKER_TOKEN || '';
const hostOrigin = () => (process.env.PLUGIN_HOST_ORIGIN || '').replace(/\/$/, '');
const storageToken = () => process.env.PLUGIN_STORAGE_TOKEN || '';

/** Per-call wall clock; the host client also enforces its own timeout. */
const CALL_BUDGET_MS = 10_000;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;

interface PlayerSnapshot {
  id: string;
  name: string;
}

interface CtxEnvelope {
  actorUserId: string;
  players: PlayerSnapshot[];
  voiceParticipants: string[];
  /** Scoping for storage capabilities. */
  serverId: string;
  pluginId: string;
}

interface LoadedPlugin {
  plugin: GamePlugin<unknown, unknown, unknown>;
}

const loaded = new Map<string, LoadedPlugin>();

function isValidGamePlugin(obj: unknown): obj is GamePlugin<unknown, unknown, unknown> {
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

/** Import one plugin bundle (index.js or <version>/index.js layout). */
async function loadFromDisk(pluginId: string): Promise<LoadedPlugin | null> {
  const base = join(pluginsDir(), pluginId);
  if (!existsSync(base) || !statSync(base).isDirectory()) return null;

  let indexPath = join(base, 'index.js');
  if (!existsSync(indexPath)) {
    const subdirs = readdirSync(base)
      .filter((name) => statSync(join(base, name)).isDirectory())
      .sort();
    if (subdirs.length === 0) return null;
    indexPath = join(base, subdirs[subdirs.length - 1]!, 'index.js');
    if (!existsSync(indexPath)) return null;
  }

  const mod = (await import(pathToFileURL(indexPath).href)) as {
    plugin?: unknown;
    default?: unknown;
  };
  const raw = mod?.plugin ?? mod?.default;
  if (!isValidGamePlugin(raw)) return null;
  if (raw.manifest.id !== pluginId) return null;
  return { plugin: raw };
}

async function getPlugin(pluginId: string): Promise<LoadedPlugin | null> {
  const cached = loaded.get(pluginId);
  if (cached) return cached;
  const fresh = await loadFromDisk(pluginId);
  if (fresh) loaded.set(pluginId, fresh);
  return fresh;
}

/**
 * Storage capability proxy — runs in the WORKER on the plugin's behalf,
 * executes on the HOST. Scoped to the envelope's (serverId, pluginId),
 * so one plugin can never reach another plugin's keyspace.
 */
function storageContext(env: CtxEnvelope) {
  const call = async (op: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const res = await fetch(`${hostOrigin()}/api/internal/plugin-storage`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lf-plugin-storage-token': storageToken(),
      },
      body: JSON.stringify({ op, serverId: env.serverId, pluginId: env.pluginId, ...args }),
    });
    if (!res.ok) {
      throw new Error(`plugin-storage ${op} failed: HTTP ${res.status}`);
    }
    return (await res.json()) as unknown;
  };
  return {
    get: async (key: string) =>
      ((await call('get', { key })) as { value: unknown }).value,
    set: async (key: string, value: unknown) => void (await call('set', { key, value })),
    delete: async (key: string) =>
      Boolean(((await call('delete', { key })) as { deleted: boolean }).deleted),
    list: async () =>
      ((await call('list')) as { items: Array<{ key: string; value: unknown }> }).items,
    clear: async () => void (await call('clear')),
  };
}

/** Build the plugin-visible context from the SNAPSHOT envelope. */
function buildCtx(env: CtxEnvelope): GamePluginContext {
  return {
    actorUserId: env.actorUserId,
    players: {
      list: () => env.players.map((p) => p.id),
      get: (playerId: string) => env.players.find((p) => p.id === playerId),
    },
    messages: {
      // Same contract as the in-process runtime: the host persists the
      // returned state; mid-call channel posts are logged, not sent.
      sendGameMessage: async (message: string) => {
        console.info(`[plugin-worker] ${env.pluginId}@${env.serverId}: ${message}`);
      },
    },
    state: {
      save: async (_state: unknown) => {
        /* host persists the returned state after the call — no-op */
      },
    },
    cache: {
      get: async () => undefined,
      set: async () => undefined,
    },
    pubsub: {
      publish: async () => undefined,
      subscribe: async () => undefined,
    },
    timer: {
      start: async () => undefined,
      stop: async () => undefined,
    },
    votes: {
      create: async () => undefined,
    },
    scores: {
      add: async () => undefined,
    },
    voice: {
      getParticipants: () => env.voiceParticipants,
    },
    storage: storageContext(env),
  } as GamePluginContext;
}

function withBudget<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('plugin call exceeded its budget')), CALL_BUDGET_MS);
    fn()
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      )
      .catch(() => undefined);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(payload);
}

function readBody(req: http.IncomingMessage, cap = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > cap) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('request aborted')));
  });
}

async function handleRpc(rawBody: Buffer): Promise<{ status: number; body: unknown }> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: 'Invalid JSON' } };
  }
  const op = msg.op;

  if (op === 'list') {
    const entries = existsSync(pluginsDir())
      ? readdirSync(pluginsDir()).filter((name) => statSync(join(pluginsDir(), name)).isDirectory())
      : [];
    const plugins: Array<{ id: string; name: string; version: string | null }> = [];
    for (const id of entries) {
      const loadedPlugin = await getPlugin(id);
      if (loadedPlugin) {
        plugins.push({
          id,
          name: loadedPlugin.plugin.manifest.name,
          version: loadedPlugin.plugin.manifest.version ?? null,
        });
      }
    }
    return { status: 200, body: { plugins } };
  }

  if (op === 'createInitialState' || op === 'handleAction' || op === 'migrateState') {
    const pluginId = String(msg.pluginId ?? '');
    const loadedPlugin = await getPlugin(pluginId);
    if (!loadedPlugin) return { status: 404, body: { error: `Plugin "${pluginId}" not loaded` } };

    try {
      let result: unknown;
      if (op === 'createInitialState') {
        const ctx = buildCtx(msg.ctx as CtxEnvelope);
        result = await withBudget(() =>
          Promise.resolve(loadedPlugin.plugin.createInitialState(ctx))
        );
      } else if (op === 'handleAction') {
        const ctx = buildCtx(msg.ctx as CtxEnvelope);
        result = await withBudget(() =>
          Promise.resolve(loadedPlugin.plugin.handleAction(ctx, msg.state, msg.action))
        );
      } else {
        result = await withBudget(() =>
          Promise.resolve(
            loadedPlugin.plugin.migrateState
              ? loadedPlugin.plugin.migrateState(msg.raw)
              : msg.raw
          )
        );
      }
      const serialized = JSON.stringify(result ?? null);
      if (serialized.length > MAX_RESULT_BYTES) {
        return { status: 413, body: { error: 'Plugin result exceeds the size cap' } };
      }
      return { status: 200, body: { result: JSON.parse(serialized) } };
    } catch (err) {
      return {
        status: 500,
        body: { error: `Plugin "${pluginId}" failed: ${(err as Error).message}` },
      };
    }
  }

  return { status: 400, body: { error: 'Unknown op' } };
}

export function createPluginWorkerServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      json(res, 200, { ok: true, service: 'plugin-worker', loaded: loaded.size });
      return;
    }
    if (req.url === '/rpc' && req.method === 'POST') {
      if (!rpcToken() || req.headers['x-lf-worker-token'] !== rpcToken()) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
      readBody(req)
        .then((body) => handleRpc(body))
        .then(({ status, body }) => json(res, status, body))
        .catch((err) => json(res, 400, { error: (err as Error).message }));
      return;
    }
    json(res, 404, { error: 'Not found' });
  });
}

// CLI entry (compose): start listening.
if (process.env.PLUGIN_WORKER_STANDALONE === '1') {
  createPluginWorkerServer().listen(PORT, HOST, () => {
    console.log(`[plugin-worker] listening on ${HOST}:${PORT}, plugins dir ${pluginsDir()}`);
  });
}
