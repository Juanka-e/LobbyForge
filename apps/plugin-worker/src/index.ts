/**
 * Plugin worker — the runtime for marketplace (dynamic) plugins (ADR-007).
 *
 * Marketplace plugin code never runs in the web process, and since
 * ADR-007 it never runs as Node either: a bundle is `sdk: "sandbox-v1"`
 * (`manifest.json` + `server.js`), and `server.js` runs inside a QuickJS
 * WebAssembly VM with no host functions, one fresh VM per call, inside a
 * pool of executor threads that are killed when a call overruns
 * (sandbox-core.mjs, sandbox-pool.ts). Per call: 32 MB of VM memory, a
 * 256 KiB VM stack, the call budget (PLUGIN_CALL_BUDGET_MS, default 2 s)
 * as an interrupt deadline plus a hard thread kill shortly after, and a
 * 4 MiB cap on the result.
 *
 * Defence in depth around that, in compose: a separate container with no
 * host secrets except the RPC token, a read-only mount of the install
 * directory, memory/pid caps, no capabilities, no-new-privileges, and a
 * network that only the web app joins. The worker makes no outbound calls
 * (there is no plugin storage in sandbox v1).
 *
 * RPC surface (POST /rpc, header `x-lf-worker-token`). Every op names the
 * exact bundle — `pluginId`, the active `version` and the `digest` of its
 * files, as recorded by the web app's installer — and the worker refuses
 * anything else (bundle.ts).
 *   { op: 'describe', ...ref }                          → { plugin: {...manifest, has*} }
 *   { op: 'createInitialState', ...ref, ctx }           → { result }
 *   { op: 'handleAction', ...ref, ctx, state, action }  → { result } | { unchanged: true }
 *   { op: 'validateAction', ...ref, action }            → { result: string | null }
 *   { op: 'projectState', ...ref, state, viewerId, ctx }→ { result }
 *   { op: 'migrateState', ...ref, raw }                 → { result }
 */
import * as http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  pluginInstallDir,
  readBundleRef,
  resolveBundle,
  type LoadedBundle,
  type VerifiedBundles,
} from './bundle.js';
import { SandboxPool, type SandboxOp } from './sandbox-pool.js';

const PORT = parseInt(process.env.PLUGIN_WORKER_PORT || '7101', 10);
const HOST = process.env.PLUGIN_WORKER_HOST || '0.0.0.0';

// Read the runtime knobs LAZILY (tests set process.env after import).
// The install root is LOBBYFORGE_PLUGIN_INSTALL_DIR (shared with the web
// app's installer; PLUGINS_DIR is the old name), default /app/plugins/installed.
const pluginsDir = () => pluginInstallDir();
const rpcToken = () => process.env.PLUGIN_WORKER_TOKEN || '';

/** Constant-time check of the RPC token (hash first: equal lengths for timingSafeEqual). */
function tokenMatches(provided: string | string[] | undefined): boolean {
  const expected = rpcToken();
  if (!expected || typeof provided !== 'string') return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Result cap (UTF-8 bytes of the plugin's JSON output). */
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;
/** Request cap: state + action + ctx. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** QuickJS heap per call (ADR-007). */
export const SANDBOX_MEMORY_BYTES = 32 * 1024 * 1024;
/** QuickJS stack per call: deep enough for ordinary recursion, caught before the thread's native stack. */
export const SANDBOX_STACK_BYTES = 256 * 1024;
/** Extra time after the budget before the executor thread is killed. */
const KILL_GRACE_MS = 250;
const MAX_PLAYERS = 500;
const ID_MAX = 128;
const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Per-call budget, ms. The web app's RPC timeout (10 s) stays above it. */
const callBudgetMs = () => envInt('PLUGIN_CALL_BUDGET_MS', 2_000, 50, 10_000);
/** CSPRNG floats handed to createInitialState / handleAction (ctx.random). */
const randomValuesPerCall = () => envInt('PLUGIN_RANDOM_VALUES', 1024, 0, 65_536);

let pool: SandboxPool | null = null;

function getPool(): SandboxPool {
  if (!pool) {
    pool = new SandboxPool({
      size: envInt('PLUGIN_SANDBOX_THREADS', 2, 1, 8),
      limits: {
        budgetMs: callBudgetMs(),
        memoryBytes: SANDBOX_MEMORY_BYTES,
        stackBytes: SANDBOX_STACK_BYTES,
        maxOutputBytes: MAX_RESULT_BYTES,
      },
      killGraceMs: KILL_GRACE_MS,
      maxQueue: 64,
      queueTimeoutMs: 5_000,
    });
  }
  return pool;
}

/** Stop the executor threads (tests, shutdown). The next call starts a new pool. */
export async function closeSandboxPool(): Promise<void> {
  const current = pool;
  pool = null;
  await current?.close();
}

/** Bundles whose digest has been verified, with their manifest and server.js. */
const verifiedBundles: VerifiedBundles = new Map();

/** Uniform floats in [0, 1) with 53 random bits each, from the CSPRNG. */
export function cryptoRandomFloats(count: number): number[] {
  const bytes = randomBytes(count * 8);
  const values: number[] = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const high = bytes.readUInt32BE(i * 8) >>> 5; // 27 bits
    const low = bytes.readUInt32BE(i * 8 + 4) >>> 6; // 26 bits
    values[i] = (high * 67_108_864 + low) / 9_007_199_254_740_992;
  }
  return values;
}

function boundedId(value: unknown): string {
  return typeof value === 'string' && value.length <= ID_MAX ? value : '';
}

function nullableId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= ID_MAX ? value : null;
}

/**
 * The ctx a plugin sees in createInitialState / handleAction: plain data
 * only. `random()` is added inside the VM, drawing from the CSPRNG values
 * passed with the call.
 */
interface SandboxCtx {
  players: Array<{ id: string; name: string }>;
  now: number;
  locale: string;
  sessionId: string;
  serverId: string;
  hostId: string | null;
  actorId: string | null;
}

/**
 * The ctx projectState gets: the state, the viewer and these — nothing
 * that differs between the REST, SSE and WebSocket paths (no players, no
 * locale: the gateway knows neither), and no random draws.
 */
interface SandboxReadCtx {
  now: number;
  sessionId: string;
  serverId: string;
  hostId: string | null;
}

function readProjectionCtx(raw: unknown): SandboxReadCtx {
  const env = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  return {
    now: typeof env.now === 'number' && Number.isFinite(env.now) ? env.now : Date.now(),
    sessionId: boundedId(env.sessionId),
    serverId: boundedId(env.serverId),
    hostId: nullableId(env.hostId),
  };
}

function readCtx(raw: unknown): SandboxCtx {
  const env = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const players: SandboxCtx['players'] = [];
  if (Array.isArray(env.players)) {
    for (const entry of env.players.slice(0, MAX_PLAYERS)) {
      if (!entry || typeof entry !== 'object') continue;
      const p = entry as { id?: unknown; name?: unknown };
      const id = boundedId(p.id);
      if (!id) continue;
      players.push({ id, name: typeof p.name === 'string' ? p.name.slice(0, 100) : id });
    }
  }
  const now = typeof env.now === 'number' && Number.isFinite(env.now) ? env.now : Date.now();
  const locale = typeof env.locale === 'string' && LOCALE_RE.test(env.locale) ? env.locale : 'en';
  return {
    players,
    now,
    locale,
    sessionId: boundedId(env.sessionId),
    serverId: boundedId(env.serverId),
    hostId: nullableId(env.hostId),
    actorId: nullableId(env.actorId ?? env.actorUserId),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type RpcReply = { status: number; body: unknown };

type OpOutcome = { ok: true; value: unknown; unchanged: boolean } | { ok: false; reply: RpcReply };

async function runOp(bundle: LoadedBundle, input: Record<string, unknown> & { op: SandboxOp }): Promise<OpOutcome> {
  const pluginId = bundle.manifest.id;
  const result = await getPool().run({ source: bundle.source, input: JSON.stringify(input) });
  if (!result.ok) {
    if (result.kind === 'output') return { ok: false, reply: { status: 413, body: { error: 'Plugin result exceeds the size cap' } } };
    const status = result.kind === 'busy' ? 503 : 500;
    return { ok: false, reply: { status, body: { error: `Plugin "${pluginId}" failed: ${result.error}` } } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.output);
  } catch {
    return { ok: false, reply: { status: 500, body: { error: `Plugin "${pluginId}" failed: its result is not JSON` } } };
  }
  if (isPlainObject(parsed) && parsed.u === 1 && input.op === 'handleAction') return { ok: true, value: null, unchanged: true };
  if (!isPlainObject(parsed) || !('r' in parsed)) {
    return { ok: false, reply: { status: 500, body: { error: `Plugin "${pluginId}" failed: malformed result` } } };
  }
  return { ok: true, value: parsed.r, unchanged: false };
}

const OPS = new Set<SandboxOp>(['describe', 'createInitialState', 'handleAction', 'validateAction', 'projectState', 'migrateState']);

async function handleRpc(rawBody: Buffer): Promise<RpcReply> {
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    if (!isPlainObject(parsed)) return { status: 400, body: { error: 'Invalid JSON' } };
    msg = parsed;
  } catch {
    return { status: 400, body: { error: 'Invalid JSON' } };
  }
  const op = msg.op;
  if (typeof op !== 'string' || !OPS.has(op as SandboxOp)) return { status: 400, body: { error: 'Unknown op' } };

  const ref = readBundleRef(msg);
  const bundle = resolveBundle(pluginsDir(), ref, verifiedBundles);
  if (!bundle.ok) return { status: bundle.status, body: { error: bundle.error } };
  const { manifest } = bundle;

  if (op === 'describe') {
    // The policies and metadata come from the manifest (data the host
    // validates), never from code; the VM only reports which functions
    // server.js defines.
    const outcome = await runOp(bundle, { op: 'describe' });
    if (!outcome.ok) return outcome.reply;
    const flags = (isPlainObject(outcome.value) ? outcome.value : {}) as Record<string, unknown>;
    if (flags.createInitialState !== true || flags.handleAction !== true) {
      return {
        status: 422,
        body: { error: `Plugin "${manifest.id}": server.js must set globalThis.plugin with createInitialState and handleAction functions` },
      };
    }
    return {
      status: 200,
      body: {
        plugin: {
          ...manifest,
          hasValidateAction: flags.validateAction === true,
          hasProjection: flags.projectState === true,
          hasMigrateState: flags.migrateState === true,
        },
      },
    };
  }

  let input: Record<string, unknown> & { op: SandboxOp };
  if (op === 'createInitialState') {
    input = { op, ctx: readCtx(msg.ctx), random: cryptoRandomFloats(randomValuesPerCall()) };
  } else if (op === 'handleAction') {
    if (!isPlainObject(msg.action)) return { status: 400, body: { error: 'action must be an object' } };
    input = { op, ctx: readCtx(msg.ctx), state: msg.state ?? null, action: msg.action, random: cryptoRandomFloats(randomValuesPerCall()) };
  } else if (op === 'validateAction') {
    if (!isPlainObject(msg.action)) return { status: 400, body: { error: 'action must be an object' } };
    input = { op, action: msg.action };
  } else if (op === 'projectState') {
    input = { op, ctx: readProjectionCtx(msg.ctx), state: msg.state ?? null, viewerId: nullableId(msg.viewerId) };
  } else {
    input = { op: 'migrateState', raw: msg.raw ?? null };
  }

  const outcome = await runOp(bundle, input);
  if (!outcome.ok) return outcome.reply;
  if (outcome.unchanged) return { status: 200, body: { unchanged: true } };

  if (op === 'validateAction') {
    const value = outcome.value;
    if (value === null || value === '') return { status: 200, body: { result: null } };
    if (typeof value === 'string') return { status: 200, body: { result: value.slice(0, 500) } };
    return {
      status: 500,
      body: { error: `Plugin "${manifest.id}" failed: validateAction must return an error string or null` },
    };
  }
  // Every other op returns a state: a JSON object.
  if (!isPlainObject(outcome.value)) {
    return { status: 500, body: { error: `Plugin "${manifest.id}" failed: ${op} must return an object` } };
  }
  return { status: 200, body: { result: outcome.value } };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(payload);
}

function readBody(req: http.IncomingMessage, cap = MAX_REQUEST_BYTES): Promise<Buffer> {
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

export function createPluginWorkerServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      json(res, 200, {
        ok: true,
        service: 'plugin-worker',
        runtime: 'quickjs-sandbox-v1',
        loaded: verifiedBundles.size,
        sandbox: pool?.stats() ?? { threads: 0, ready: 0, busy: 0, queued: 0 },
      });
      return;
    }
    if (req.url === '/rpc' && req.method === 'POST') {
      if (!tokenMatches(req.headers['x-lf-worker-token'])) {
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
  const server = createPluginWorkerServer();
  server.listen(PORT, HOST, () => {
    console.info(`[plugin-worker] listening on ${HOST}:${PORT}, plugins dir ${pluginsDir()}, QuickJS sandbox (sandbox-v1)`);
  });
  const shutdown = () => {
    server.close();
    void closeSandboxPool().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
