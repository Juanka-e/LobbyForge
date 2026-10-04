/**
 * The plugin worker (ADR-007): sandbox-v1 bundles run in QuickJS. These
 * tests spin the REAL HTTP server on an ephemeral port with a temp install
 * directory and drive it with real fetch calls, the path the web app's
 * client takes; plugin code runs in the real executor threads.
 *
 * Escape attempts: no `process`, `require`, `import()`, Function-constructor
 * trick, timers or network reach anything; an infinite loop, a long native
 * loop, a memory bomb, a stack bomb and a huge result each fail the CALL
 * and leave the worker healthy; ctx.random() runs out instead of falling
 * back to anything predictable.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeSandboxPool, createPluginWorkerServer, cryptoRandomFloats } from '../index.js';
import { computeBundleDigest } from '../bundle.js';

const RPC_TOKEN = 'test-worker-token';
const BUDGET_MS = 1000;

let server: ReturnType<typeof createPluginWorkerServer>;
let baseUrl: string;
let pluginsDir: string;
/** `<id>@<version>` → digest of that fixture folder. */
const digests = new Map<string, string>();

function manifest(id: string, version = '1.0.0', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    name: `Fixture ${id}`,
    version,
    sdk: 'sandbox-v1',
    ui: false,
    actionPolicies: { bump: { role: 'member', actorFields: ['playerId'], joinsRoster: true }, reveal: { role: 'host' } },
    ...extra,
  });
}

function writePlugin(id: string, source: string, version = '1.0.0', files: Record<string, string> = {}): void {
  const dir = join(pluginsDir, id, version);
  mkdirSync(dir, { recursive: true });
  const all = { 'manifest.json': manifest(id, version), 'server.js': source, ...files };
  for (const [name, body] of Object.entries(all)) writeFileSync(join(dir, name), body);
  digests.set(`${id}@${version}`, computeBundleDigest(dir));
}

/** A plugin whose createInitialState returns `body` (an expression). */
const probe = (body: string, extra = '') => `${extra}
globalThis.plugin = {
  createInitialState: function (ctx) { return (${body}); },
  handleAction: function (ctx, state) { return state; },
};`;

const FIXTURE = `
var loads = 0;
loads += 1;
globalThis.plugin = {
  createInitialState: function (ctx) {
    return { loads: loads, players: ctx.players, now: ctx.now, locale: ctx.locale, sessionId: ctx.sessionId,
             serverId: ctx.serverId, hostId: ctx.hostId, actorId: ctx.actorId, r: ctx.random(), m: Math.random() };
  },
  handleAction: function (ctx, state, action) {
    if (action.type === 'noop') return state;
    return Object.assign({}, state, { count: (state.count || 0) + 1, last: action, actor: ctx.actorId });
  },
  validateAction: function (action) {
    if (action.type === 'bad') return 'bad action';
    if (action.type === 'weird') return 42;
    return null;
  },
  projectState: function (state, viewerId, ctx) {
    return { secret: viewerId === state.owner ? state.secret : null, viewer: viewerId, sessionId: ctx.sessionId, hostId: ctx.hostId,
             ctxKeys: Object.keys(ctx).sort() };
  },
  migrateState: function (raw) { return Object.assign({ schema: 2 }, raw); },
};`;

const MINIMAL = `globalThis.plugin = {
  createInitialState: function () { return { n: 0 }; },
  handleAction: function (ctx, state) { return state; },
};`;

const versioned = (version: string) => `globalThis.plugin = {
  createInitialState: function () { return { ranVersion: '${version}' }; },
  handleAction: function (ctx, state) { return state; },
};`;

beforeAll(async () => {
  // INSIDE the package (vite root): CI temp dirs can carry short-name
  // path segments (RUNNER~1).
  pluginsDir = resolve(__dirname, '..', '..', '.plugin-fixtures', 'worker');
  rmSync(pluginsDir, { recursive: true, force: true });
  writePlugin('fixture-plugin', FIXTURE);
  writePlugin('minimal-plugin', MINIMAL);
  writePlugin('versioned-plugin', versioned('1.9.0'), '1.9.0');
  writePlugin('versioned-plugin', versioned('1.10.0'), '1.10.0');
  writePlugin('no-reducer-plugin', 'globalThis.plugin = { createInitialState: function () { return {}; } };');
  writePlugin('no-plugin', 'var x = 1;');
  writePlugin('load-throws', 'throw new Error("boom at load");');
  writePlugin('load-random', 'var seed = Math.random(); globalThis.plugin = { createInitialState: function () { return {}; }, handleAction: function (c, s) { return s; } };');
  writePlugin(
    'escape-probe',
    probe(`{
      process: typeof process, require: typeof require, module: typeof module, exports: typeof exports,
      fetch: typeof fetch, XMLHttpRequest: typeof XMLHttpRequest, WebAssembly: typeof WebAssembly,
      setTimeout: typeof setTimeout, setInterval: typeof setInterval, queueMicrotask: typeof queueMicrotask,
      console: typeof console, std: typeof std, os: typeof os, Atomics: typeof Atomics,
      SharedArrayBuffer: typeof SharedArrayBuffer, Deno: typeof Deno, Bun: typeof Bun,
      ctorTrick: (function () { try { return globalThis.constructor.constructor('return typeof process')(); } catch (e) { return 'threw'; } })(),
      fnTrick: (function () { try { return Function('return typeof require + typeof process')(); } catch (e) { return 'threw'; } })(),
      evalTrick: (function () { try { return eval('typeof process'); } catch (e) { return 'threw'; } })(),
      globalKeys: Object.getOwnPropertyNames(globalThis).filter(function (k) { return /process|require|fetch|host|lf|std|os/i.test(k); }),
      dynamicImport: importState
    }`, `var importState = 'not attempted';
try {
  var p = import('node:fs');
  importState = 'pending';
  p.then(function () { importState = 'loaded'; }, function () { importState = 'rejected'; });
} catch (e) { importState = 'threw'; }`)
  );
  writePlugin('require-plugin', probe(`{ fs: require('fs') }`));
  writePlugin('hang-plugin', probe(`(function () { while (true) {} })()`));
  writePlugin(
    'native-hang-plugin',
    probe(`(function () { var a = []; for (var i = 0; i < 200000; i++) a.push(-i); while (true) a.sort(); })()`)
  );
  writePlugin('memory-plugin', probe(`(function () { var a = []; while (true) a.push(new Array(100000).fill(1.5)); })()`));
  writePlugin('stack-plugin', probe(`(function f(n) { return f(n + 1) + 1; })(0)`));
  writePlugin('huge-output-plugin', probe(`{ blob: 'x'.repeat(5 * 1024 * 1024) }`));
  writePlugin('random-drain-plugin', probe(`(function () { var out = []; for (var i = 0; i < 5; i++) out.push(ctx.random()); return { out: out }; })()`));
  writePlugin(
    'random-swallow-plugin',
    probe(`(function () { var n = 0; try { for (;;) { ctx.random(); n++; } } catch (e) { return { drawn: n }; } })()`)
  );
  writePlugin('promise-plugin', probe(`Promise.resolve({ later: true })`));
  writePlugin('array-state-plugin', probe(`[1, 2, 3]`));
  writePlugin(
    'tamper-plugin',
    probe(`{ ok: true }`, `JSON.stringify = function () { return '{"r":{"forged":true}}'; }; JSON.parse = function () { return {}; };`)
  );
  // A legacy Node bundle: index.js only.
  const legacyDir = join(pluginsDir, 'legacy-node', '1.0.0');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'index.js'), 'export const plugin = {};');
  digests.set('legacy-node@1.0.0', computeBundleDigest(legacyDir));

  delete process.env.PLUGINS_DIR;
  process.env.LOBBYFORGE_PLUGIN_INSTALL_DIR = pluginsDir;
  process.env.PLUGIN_CALL_BUDGET_MS = String(BUDGET_MS);
  process.env.PLUGIN_WORKER_TOKEN = RPC_TOKEN;
  server = createPluginWorkerServer();
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

beforeEach(() => {
  delete process.env.PLUGIN_RANDOM_VALUES;
});

afterAll(async () => {
  server.close();
  await closeSandboxPool();
  rmSync(pluginsDir, { recursive: true, force: true });
});

/** The exact-bundle fields every RPC carries. */
function bundle(pluginId: string, version = '1.0.0') {
  const digest = digests.get(`${pluginId}@${version}`) ?? '0'.repeat(64);
  return { pluginId, version, digest };
}

async function rpc(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lf-worker-token': RPC_TOKEN },
    body: JSON.stringify(body),
  });
}

async function rpcJson<T = Record<string, unknown>>(body: unknown): Promise<{ status: number; body: T }> {
  const res = await rpc(body);
  return { status: res.status, body: (await res.json()) as T };
}

async function expectHealthy(): Promise<void> {
  const health = await fetch(`${baseUrl}/health`);
  expect(health.status).toBe(200);
}

const CTX = {
  actorId: 'user-1',
  players: [
    { id: 'user-1', name: 'Alice' },
    { id: 'user-2', name: 'Bob' },
  ],
  now: 1_700_000_000_000,
  locale: 'tr',
  sessionId: 'sess-1',
  serverId: 'srv-1',
  hostId: 'user-1',
};

describe('plugin-worker RPC', () => {
  it('health endpoint answers (compose healthcheck path)', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; runtime: string };
    expect(body.service).toBe('plugin-worker');
    expect(body.runtime).toBe('quickjs-sandbox-v1');
  });

  it('rejects RPC without the shared token', async () => {
    const res = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'describe', ...bundle('fixture-plugin') }),
    });
    expect(res.status).toBe(401);
  });

  it('describe returns the MANIFEST policies plus which functions server.js defines', async () => {
    const { status, body } = await rpcJson<{ plugin: Record<string, unknown> }>({ op: 'describe', ...bundle('fixture-plugin') });
    expect(status).toBe(200);
    expect(body.plugin).toEqual({
      id: 'fixture-plugin',
      name: 'Fixture fixture-plugin',
      version: '1.0.0',
      sdk: 'sandbox-v1',
      ui: false,
      locales: ['en'],
      actionPolicies: { bump: { role: 'member', actorFields: ['playerId'], joinsRoster: true }, reveal: { role: 'host' } },
      hasValidateAction: true,
      hasProjection: true,
      hasMigrateState: true,
    });
    const minimal = await rpcJson<{ plugin: Record<string, unknown> }>({ op: 'describe', ...bundle('minimal-plugin') });
    expect(minimal.body.plugin).toMatchObject({ hasValidateAction: false, hasProjection: false, hasMigrateState: false });
  });

  it('describe refuses a server.js without the required functions (422)', async () => {
    for (const id of ['no-reducer-plugin', 'no-plugin']) {
      const { status, body } = await rpcJson<{ error: string }>({ op: 'describe', ...bundle(id) });
      expect(status, id).toBe(id === 'no-plugin' ? 500 : 422);
      expect(body.error).toMatch(/globalThis\.plugin/);
    }
  });

  it('a server.js that throws at load fails the call with its message', async () => {
    const { status, body } = await rpcJson<{ error: string }>({ op: 'describe', ...bundle('load-throws') });
    expect(status).toBe(500);
    expect(body.error).toContain('boom at load');
  });

  it('a legacy Node bundle (index.js) is refused (422)', async () => {
    const { status, body } = await rpcJson<{ error: string }>({ op: 'describe', ...bundle('legacy-node') });
    expect(status).toBe(422);
    expect(body.error).toMatch(/legacy Node bundle/);
  });

  it('runs EXACTLY the requested version: 1.9.0 and 1.10.0 each run their own folder', async () => {
    const older = await rpcJson<{ result: { ranVersion: string } }>({ op: 'createInitialState', ...bundle('versioned-plugin', '1.9.0'), ctx: CTX });
    expect(older.body.result.ranVersion).toBe('1.9.0');
    const newer = await rpcJson<{ result: { ranVersion: string } }>({ op: 'createInitialState', ...bundle('versioned-plugin', '1.10.0'), ctx: CTX });
    expect(newer.body.result.ranVersion).toBe('1.10.0');
  });

  it('refuses a digest that does not match the folder (409, nothing runs)', async () => {
    const res = await rpc({
      op: 'createInitialState',
      pluginId: 'versioned-plugin',
      version: '1.9.0',
      digest: bundle('versioned-plugin', '1.10.0').digest,
      ctx: CTX,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/digest mismatch/);
  });

  it('refuses a request without an exact version and digest, and path-like refs (400)', async () => {
    const digest = bundle('fixture-plugin').digest;
    for (const body of [
      { op: 'createInitialState', pluginId: 'fixture-plugin', ctx: CTX },
      { op: 'migrateState', pluginId: 'fixture-plugin', version: '1.0.0', raw: {} },
      { op: 'describe', pluginId: 'fixture-plugin', version: 'latest', digest },
      { op: 'describe', pluginId: '../fixture-plugin', version: '1.0.0', digest },
      { op: 'describe', pluginId: 'fixture-plugin', version: '../../etc', digest },
    ]) {
      expect((await rpc(body)).status).toBe(400);
    }
  });

  it('a version or plugin that is not installed → 404', async () => {
    expect((await rpc({ op: 'describe', ...bundle('versioned-plugin', '2.0.0') })).status).toBe(404);
    expect((await rpc({ op: 'createInitialState', ...bundle('nope'), ctx: CTX })).status).toBe(404);
  });

  it('createInitialState gets plain-data ctx: players, now, locale, ids and CSPRNG random', async () => {
    const { status, body } = await rpcJson<{ result: Record<string, unknown> }>({
      op: 'createInitialState',
      ...bundle('fixture-plugin'),
      ctx: { ...CTX, players: [...CTX.players, { id: 42, name: 'not a string id' }], locale: '../../x' },
    });
    expect(status).toBe(200);
    expect(body.result).toMatchObject({
      loads: 1,
      players: CTX.players,
      now: CTX.now,
      locale: 'en', // an invalid locale falls back
      sessionId: 'sess-1',
      serverId: 'srv-1',
      hostId: 'user-1',
      actorId: 'user-1',
    });
    for (const key of ['r', 'm'] as const) {
      expect(typeof body.result[key]).toBe('number');
      expect(body.result[key]).toBeGreaterThanOrEqual(0);
      expect(body.result[key]).toBeLessThan(1);
    }
  });

  it('every call gets a fresh VM: top-level state does not survive between calls', async () => {
    for (let i = 0; i < 2; i++) {
      const { body } = await rpcJson<{ result: { loads: number } }>({ op: 'createInitialState', ...bundle('fixture-plugin'), ctx: CTX });
      expect(body.result.loads).toBe(1);
    }
  });

  it('handleAction round-trips state + action; returning the same state reports unchanged', async () => {
    const changed = await rpcJson<{ result: Record<string, unknown> }>({
      op: 'handleAction',
      ...bundle('fixture-plugin'),
      ctx: CTX,
      state: { count: 1 },
      action: { type: 'bump', playerId: 'user-2' },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.result).toEqual({ count: 2, last: { type: 'bump', playerId: 'user-2' }, actor: 'user-1' });

    const refused = await rpcJson({ op: 'handleAction', ...bundle('fixture-plugin'), ctx: CTX, state: { count: 1 }, action: { type: 'noop' } });
    expect(refused).toEqual({ status: 200, body: { unchanged: true } });

    expect((await rpc({ op: 'handleAction', ...bundle('fixture-plugin'), ctx: CTX, state: {}, action: 'bump' })).status).toBe(400);
  });

  it('validateAction: an error string, null, or a 500 for anything else', async () => {
    expect(await rpcJson({ op: 'validateAction', ...bundle('fixture-plugin'), action: { type: 'bad' } })).toEqual({
      status: 200,
      body: { result: 'bad action' },
    });
    expect(await rpcJson({ op: 'validateAction', ...bundle('fixture-plugin'), action: { type: 'bump' } })).toEqual({
      status: 200,
      body: { result: null },
    });
    const weird = await rpcJson<{ error: string }>({ op: 'validateAction', ...bundle('fixture-plugin'), action: { type: 'weird' } });
    expect(weird.status).toBe(500);
    expect(weird.body.error).toMatch(/error string or null/);
    // A plugin without validateAction accepts everything.
    expect(await rpcJson({ op: 'validateAction', ...bundle('minimal-plugin'), action: { type: 'x' } })).toEqual({
      status: 200,
      body: { result: null },
    });
  });

  it('projectState runs per viewer; its ctx has no players, no locale and no random draws', async () => {
    const state = { owner: 'user-2', secret: 'the card' };
    const owner = await rpcJson<{ result: Record<string, unknown> }>({
      op: 'projectState',
      ...bundle('fixture-plugin'),
      state,
      viewerId: 'user-2',
      ctx: CTX,
    });
    expect(owner.body.result).toEqual({
      secret: 'the card',
      viewer: 'user-2',
      sessionId: 'sess-1',
      hostId: 'user-1',
      // random() is always defined by the VM; with no values it throws.
      ctxKeys: ['hostId', 'now', 'random', 'serverId', 'sessionId'],
    });
    const other = await rpcJson<{ result: Record<string, unknown> }>({
      op: 'projectState',
      ...bundle('fixture-plugin'),
      state,
      viewerId: 'user-1',
      ctx: CTX,
    });
    expect(other.body.result.secret).toBeNull();
    // Without projectState the state is returned as is (public).
    const minimal = await rpcJson({ op: 'projectState', ...bundle('minimal-plugin'), state, viewerId: 'user-1', ctx: CTX });
    expect(minimal).toEqual({ status: 200, body: { result: state } });
  });

  it('migrateState runs in the sandbox; without it the raw state comes back', async () => {
    expect(await rpcJson({ op: 'migrateState', ...bundle('fixture-plugin'), raw: { old: 1 } })).toEqual({
      status: 200,
      body: { result: { schema: 2, old: 1 } },
    });
    expect(await rpcJson({ op: 'migrateState', ...bundle('minimal-plugin'), raw: { old: 1 } })).toEqual({
      status: 200,
      body: { result: { old: 1 } },
    });
  });

  it('a state op must return an object; a Promise is refused (calls are synchronous)', async () => {
    const arrayState = await rpcJson<{ error: string }>({ op: 'createInitialState', ...bundle('array-state-plugin'), ctx: CTX });
    expect(arrayState.status).toBe(500);
    expect(arrayState.body.error).toMatch(/must return an object/);
    const promised = await rpcJson<{ error: string }>({ op: 'createInitialState', ...bundle('promise-plugin'), ctx: CTX });
    expect(promised.status).toBe(500);
    expect(promised.body.error).toMatch(/synchronous/);
  });

  it('malformed JSON and unknown ops → 400', async () => {
    const res = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lf-worker-token': RPC_TOKEN },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    expect((await rpc({ op: 'explode', ...bundle('fixture-plugin') })).status).toBe(400);
    expect((await rpc({ op: 'list' })).status).toBe(400);
  });
});

describe('the sandbox holds', () => {
  it('nothing from the host is reachable: process, require, fetch, timers, Function/eval tricks, import()', async () => {
    const { status, body } = await rpcJson<{ result: Record<string, unknown> }>({
      op: 'createInitialState',
      ...bundle('escape-probe'),
      ctx: CTX,
    });
    expect(status).toBe(200);
    const r = body.result;
    for (const key of [
      'process', 'require', 'module', 'exports', 'fetch', 'XMLHttpRequest', 'WebAssembly', 'setTimeout',
      'setInterval', 'queueMicrotask', 'console', 'std', 'os', 'Atomics', 'SharedArrayBuffer', 'Deno', 'Bun',
    ]) {
      expect(r[key], key).toBe('undefined');
    }
    expect(r.ctorTrick).toBe('undefined');
    expect(r.fnTrick).toBe('undefinedundefined');
    expect(r.evalTrick).toBe('undefined');
    expect(r.globalKeys).toEqual([]);
    // No module loader: a dynamic import never loads anything.
    expect(['pending', 'rejected', 'threw']).toContain(r.dynamicImport);
  });

  it('require() is a ReferenceError inside the VM', async () => {
    const { status, body } = await rpcJson<{ error: string }>({ op: 'createInitialState', ...bundle('require-plugin'), ctx: CTX });
    expect(status).toBe(500);
    expect(body.error).toMatch(/ReferenceError: '?require'? is not defined/);
  });

  it('Math.random() at load time throws (use ctx.random() inside a call)', async () => {
    const { status, body } = await rpcJson<{ error: string }>({ op: 'describe', ...bundle('load-random') });
    expect(status).toBe(500);
    expect(body.error).toMatch(/ctx\.random/);
  });

  it('a plugin cannot forge the host envelope by replacing JSON built-ins', async () => {
    const { status, body } = await rpcJson({ op: 'createInitialState', ...bundle('tamper-plugin'), ctx: CTX });
    expect(status).toBe(200);
    expect(body).toEqual({ result: { ok: true } });
  });

  it('an infinite loop is interrupted at the budget; the worker stays healthy', async () => {
    const start = Date.now();
    const { status, body } = await rpcJson<{ error: string }>({ op: 'createInitialState', ...bundle('hang-plugin'), ctx: CTX });
    expect(status).toBe(500);
    expect(body.error).toMatch(/budget/);
    expect(Date.now() - start).toBeLessThan(BUDGET_MS + 2_000);
    await expectHealthy();
  }, 20_000);

  it('a long NATIVE loop (sort) that ignores the interrupt is killed with its thread', async () => {
    const start = Date.now();
    const { status, body } = await rpcJson<{ error: string }>({ op: 'createInitialState', ...bundle('native-hang-plugin'), ctx: CTX });
    expect(status).toBe(500);
    expect(body.error).toMatch(/budget/);
    expect(Date.now() - start).toBeLessThan(BUDGET_MS + 3_000);
    await expectHealthy();
    // A replacement thread serves the next call.
    const next = await rpcJson({ op: 'createInitialState', ...bundle('minimal-plugin'), ctx: CTX });
    expect(next).toEqual({ status: 200, body: { result: { n: 0 } } });
  }, 20_000);

  it('a memory bomb hits the 32 MB limit', async () => {
    const { status, body } = await rpcJson<{ error: string }>({ op: 'createInitialState', ...bundle('memory-plugin'), ctx: CTX });
    expect(status).toBe(500);
    expect(body.error).toMatch(/memory limit|budget/);
    await expectHealthy();
  }, 20_000);

  it('unbounded recursion hits the stack limit', async () => {
    const { status, body } = await rpcJson<{ error: string }>({ op: 'createInitialState', ...bundle('stack-plugin'), ctx: CTX });
    expect(status).toBe(500);
    expect(body.error).toMatch(/stack limit/);
    await expectHealthy();
  }, 20_000);

  it('a result over 4 MiB is refused (413)', async () => {
    const { status, body } = await rpcJson<{ error: string }>({ op: 'createInitialState', ...bundle('huge-output-plugin'), ctx: CTX });
    expect(status).toBe(413);
    expect(body.error).toMatch(/size cap/);
  }, 20_000);

  it('ctx.random() fails the call when the host-provided values run out', async () => {
    process.env.PLUGIN_RANDOM_VALUES = '4';
    const drained = await rpcJson<{ error: string }>({ op: 'createInitialState', ...bundle('random-drain-plugin'), ctx: CTX });
    expect(drained.status).toBe(500);
    expect(drained.body.error).toMatch(/random values .* used up/);
    // Catching the error does not help: the call still fails.
    const swallowed = await rpcJson<{ error: string }>({ op: 'createInitialState', ...bundle('random-swallow-plugin'), ctx: CTX });
    expect(swallowed.status).toBe(500);
    expect(swallowed.body.error).toMatch(/used up/);
    process.env.PLUGIN_RANDOM_VALUES = '5';
    const enough = await rpcJson<{ result: { out: number[] } }>({ op: 'createInitialState', ...bundle('random-drain-plugin'), ctx: CTX });
    expect(enough.status).toBe(200);
    expect(enough.body.result.out).toHaveLength(5);
  });
});

describe('cryptoRandomFloats', () => {
  it('returns uniform-looking floats in [0, 1)', () => {
    const values = cryptoRandomFloats(2000);
    expect(values).toHaveLength(2000);
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
    expect(new Set(values).size).toBe(2000);
  });
});
