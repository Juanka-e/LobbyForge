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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createHmac } from 'node:crypto';
import type { GamePlugin, GamePluginContext } from '@lobbyforge/plugin-sdk';

const PORT = parseInt(process.env.PLUGIN_WORKER_PORT || '7101', 10);
const HOST = process.env.PLUGIN_WORKER_HOST || '0.0.0.0';

// Read the runtime knobs LAZILY (tests set process.env after import).
const pluginsDir = () => resolve(process.env.PLUGINS_DIR || './plugins/installed');
const rpcToken = () => process.env.PLUGIN_WORKER_TOKEN || '';
const hostOrigin = () => (process.env.PLUGIN_HOST_ORIGIN || '').replace(/\/$/, '');
// 9th-audit: the worker holds NO storage secret at all. The HOST mints
// per-RPC scoped capabilities (HMAC(serverId|pluginId|expiry) over a
// secret only the web app has) and the worker merely RELAYS them; the
// endpoint verifies capability-vs-scope. A malicious plugin reading
// this process's entire env gains nothing storage-related.

/** Per-call wall clock; the host client also enforces its own timeout. */
const CALL_BUDGET_MS = parseInt(process.env.PLUGIN_CALL_BUDGET_MS || String(10_000), 10);
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

/**
 * 10th-audit finding 2: the parent process holds ONLY filesystem
 * metadata — it never import()s a plugin bundle (ESM import runs
 * top-level code: a malicious plugin could block this process,
 * read process.env, monkeypatch globals or spy on later RPCs before
 * any executor thread existed). Importing and shape-validation happen
 * exclusively inside disposable executor threads.
 */
interface LoadedPlugin {
  pluginPath: string;
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

/** Resolve the bundle path WITHOUT importing it (parent stays clean). */
function resolvePluginPath(pluginId: string): string | null {
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
  return indexPath;
}

/**
 * 10th-audit (findings 4+5): run ONE plugin op in a dedicated
 * worker_thread with an EMPTY environment and hard resource limits,
 * terminated on timeout. The plugin can neither read worker secrets
 * (env is {}) nor block the service forever (terminate kills the
 * loop). Returns the op result; rejects on error/timeout.
 */
function runInExecutorThread(payload: {
  pluginPath: string;
  op: 'describe' | 'createInitialState' | 'handleAction' | 'migrateState';
  ctx: CtxEnvelope;
  state?: unknown;
  action?: unknown;
  raw?: unknown;
  storageCapability: string;
  storageEndpoint: string;
}): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(resolveExecutorPath(), {
      workerData: payload,
      env: {}, // NO worker secrets reach untrusted code
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
    });
    const timer = setTimeout(() => {
      void worker.terminate().catch(() => undefined);
      reject(new Error('plugin call exceeded its execution budget (thread terminated)'));
    }, CALL_BUDGET_MS);
    worker.on('message', (msg: { result?: unknown; error?: string; log?: string }) => {
      if (msg.log !== undefined) {
        console.info(`[plugin-executor] ${msg.log}`);
        return;
      }
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    });
    worker.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== 1) reject(new Error(`executor exited with code ${code}`));
    });
  });
}

function resolveExecutorPath(): string {
  // Plain-JS executor — sibling of this module in BOTH layouts:
  // dist/index.js → dist/executor.mjs (copied at build), and
  // src/index.ts under vitest → src/executor.mjs.
  return fileURLToPath(new URL('./executor.mjs', import.meta.url));
}

async function getPlugin(pluginId: string): Promise<LoadedPlugin | null> {
  const cached = loaded.get(pluginId);
  if (cached) return cached;
  const pluginPath = resolvePluginPath(pluginId);
  if (!pluginPath) return null;
  const fresh: LoadedPlugin = { pluginPath };
  loaded.set(pluginId, fresh);
  return fresh;
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
      if (!loadedPlugin) continue;
      try {
        // Manifest probe in the DISPOSABLE executor — the parent never
        // imports untrusted code (10th-audit finding 2). A broken or
        // malicious bundle only loses its own listing slot.
        const described = await runInExecutorThread({
          pluginPath: loadedPlugin.pluginPath,
          op: 'describe',
          ctx: { actorUserId: '', players: [], voiceParticipants: [], serverId: '', pluginId: id },
          storageCapability: '',
          storageEndpoint: '',
        });
        if (
          described &&
          typeof described === 'object' &&
          (described as { id?: unknown }).id === id
        ) {
          const d = described as { name?: unknown; version?: unknown };
          plugins.push({
            id,
            name: typeof d.name === 'string' ? d.name : id,
            version: typeof d.version === 'string' ? d.version : null,
          });
        }
      } catch {
        /* invalid bundle — skip its listing */
      }
    }
    return { status: 200, body: { plugins } };
  }

  if (op === 'createInitialState' || op === 'handleAction' || op === 'migrateState') {
    const pluginId = String(msg.pluginId ?? '');
    const loadedPlugin = await getPlugin(pluginId);
    if (!loadedPlugin) return { status: 404, body: { error: `Plugin "${pluginId}" not loaded` } };

    const envelope = msg.ctx as CtxEnvelope;
    // Host-minted scoped capability rides the RPC envelope.
    const capability = String(msg.storageCapability ?? '');
    const storageEndpoint = `${hostOrigin()}/api/internal/plugin-storage`;

    try {
      const result = await runInExecutorThread({
        pluginPath: loadedPlugin.pluginPath,
        op,
        ctx: envelope,
        state: msg.state,
        action: msg.action,
        raw: msg.raw,
        storageCapability: capability,
        storageEndpoint,
      });
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
