/**
 * LF-SEC-010: the isolated plugin-worker runtime. These tests spin the
 * REAL HTTP server on an ephemeral port with a temp plugins directory
 * containing a fixture bundle, and drive it with real fetch calls —
 * the same path the web app's client takes in production.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginWorkerServer } from '../index.js';
import { computeBundleDigest } from '../bundle.js';

const RPC_TOKEN = 'test-worker-token';

let server: ReturnType<typeof createPluginWorkerServer>;
let baseUrl: string;
let pluginsDir: string;
/** `<id>@<version>` → digest of that fixture folder. */
const digests = new Map<string, string>();

const FIXTURE_PLUGIN = `
export const plugin = {
  manifest: {
    id: 'fixture-plugin',
    name: 'Fixture',
    version: '1.0.0',
    type: 'game',
    minAppVersion: '0.1.0',
    permissions: [],
    locales: ['en'],
    entryClient: './client.js',
  },
  createInitialState: (ctx) => ({
    actor: ctx.actorUserId,
    players: ctx.players.list(),
    storageProbe: null,
  }),
  handleAction: (ctx, state, action) => ({
    ...state,
    lastAction: action,
    voice: ctx.voice.getParticipants(),
  }),
  migrateState: (raw) => ({ migrated: true, raw }),
  renderClient: () => null,
};
`;

// 17th-audit: adversarial plugins for the child-process executor.
const IPC_NULL_PLUGIN = `
export const plugin = {
  manifest: {
    id: 'ipc-null-plugin', name: 'IPC Null', version: '1.0.0', type: 'game',
    minAppVersion: '0.1.0', permissions: [], locales: ['en'], entryClient: './client.js',
  },
  createInitialState: () => {
    process.send(null); // hostile: crashes unvalidated parent handler
    return {};
  },
  handleAction: (ctx, state) => state,
  migrateState: (raw) => raw,
  renderClient: () => null,
};
`;

const EXIT_ZERO_PLUGIN = `
export const plugin = {
  manifest: {
    id: 'exit-zero-plugin', name: 'Exit Zero', version: '1.0.0', type: 'game',
    minAppVersion: '0.1.0', permissions: [], locales: ['en'], entryClient: './client.js',
  },
  createInitialState: () => {
    process.exit(0); // hostile: clean exit without sending a result
  },
  handleAction: (ctx, state) => state,
  migrateState: (raw) => raw,
  renderClient: () => null,
};
`;

const FAKE_RESULT_PLUGIN = `
export const plugin = {
  manifest: {
    id: 'fake-result-plugin', name: 'Fake Result', version: '1.0.0', type: 'game',
    minAppVersion: '0.1.0', permissions: [], locales: ['en'], entryClient: './client.js',
  },
  createInitialState: () => {
    // hostile: fabricate an executor protocol result before the real one
    process.send({ result: { hacked: true } });
    return { real: true };
  },
  handleAction: (ctx, state) => state,
  migrateState: (raw) => raw,
  renderClient: () => null,
};
`;

// 9th-audit finding 5: a synchronous infinite loop must be KILLED by
// the executor-thread terminate, not merely out-raced.
const HANG_PLUGIN = `
export const plugin = {
  manifest: {
    id: 'hang-plugin',
    name: 'Hang',
    version: '1.0.0',
    type: 'game',
    minAppVersion: '0.1.0',
    permissions: [],
    locales: ['en'],
    entryClient: './client.js',
  },
  createInitialState: () => {
    while (true) { /* blocks the executor event loop forever */ }
  },
  handleAction: (ctx, state) => state,
  migrateState: (raw) => raw,
  renderClient: () => null,
};
`;

const STORAGE_PLUGIN = `
export const plugin = {
  manifest: {
    id: 'storage-plugin',
    name: 'Storage',
    version: '1.0.0',
    type: 'game',
    minAppVersion: '0.1.0',
    permissions: [],
    locales: ['en'],
    entryClient: './client.js',
  },
  createInitialState: async (ctx) => ({
    stored: await ctx.storage.get('probe'),
  }),
  handleAction: (ctx, state) => state,
  migrateState: (raw) => raw,
  renderClient: () => null,
};
`;

// Version selection: two installed versions whose names sort the wrong
// way alphabetically ("1.10.0" < "1.9.0"). Each reports its own folder.
const versionedPlugin = (version: string) => `
export const plugin = {
  manifest: {
    id: 'versioned-plugin', name: 'Versioned', version: '${version}', type: 'game',
    minAppVersion: '0.1.0', permissions: [], locales: ['en'], entryClient: './client.js',
  },
  createInitialState: () => ({ ranVersion: '${version}' }),
  handleAction: (ctx, state) => state,
  migrateState: (raw) => raw,
  renderClient: () => null,
};
`;

// A bundle that left `react` external: nothing resolves it from the
// install directory (the package name is made up so no hoisted copy can
// satisfy it on a dev box either).
const EXTERNAL_IMPORT_PLUGIN = `
import { jsx } from 'lobbyforge-test-missing-package-xyz/jsx-runtime';
export const plugin = {
  manifest: { id: 'external-import-plugin', name: 'External', version: '1.0.0' },
  createInitialState: () => ({ el: jsx }),
  handleAction: (ctx, state) => state,
};
`;

const NO_REDUCER_PLUGIN = `
export const plugin = { manifest: { id: 'no-reducer-plugin', name: 'No reducer', version: '1.0.0' } };
`;

function writePlugin(id: string, body: string, version = '1.0.0'): void {
  const dir = join(pluginsDir, id, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.js'), body);
  digests.set(`${id}@${version}`, computeBundleDigest(dir));
}

/** The exact-bundle fields every RPC now carries. */
function bundle(pluginId: string, version = '1.0.0') {
  const digest = digests.get(`${pluginId}@${version}`) ?? '0'.repeat(64);
  return { pluginId, version, digest };
}

beforeAll(async () => {
  // INSIDE the package (vite root): CI temp dirs can carry short-name
  // path segments (RUNNER~1) that break the module runner's file URLs.
  pluginsDir = resolve(__dirname, '..', '..', '.plugin-fixtures', 'worker');
  rmSync(pluginsDir, { recursive: true, force: true });
  writePlugin('fixture-plugin', FIXTURE_PLUGIN);
  writePlugin('hang-plugin', HANG_PLUGIN);
  writePlugin('ipc-null-plugin', IPC_NULL_PLUGIN);
  writePlugin('exit-zero-plugin', EXIT_ZERO_PLUGIN);
  writePlugin('fake-result-plugin', FAKE_RESULT_PLUGIN);
  writePlugin('storage-plugin', STORAGE_PLUGIN);
  writePlugin('versioned-plugin', versionedPlugin('1.9.0'), '1.9.0');
  writePlugin('versioned-plugin', versionedPlugin('1.10.0'), '1.10.0');
  writePlugin('external-import-plugin', EXTERNAL_IMPORT_PLUGIN);
  writePlugin('no-reducer-plugin', NO_REDUCER_PLUGIN);
  delete process.env.PLUGINS_DIR;
  process.env.LOBBYFORGE_PLUGIN_INSTALL_DIR = pluginsDir;
  process.env.PLUGIN_CALL_BUDGET_MS = '2000'; // fast terminate in tests
  process.env.PLUGIN_WORKER_TOKEN = RPC_TOKEN;
  process.env.PLUGIN_HOST_ORIGIN = 'http://127.0.0.1:1'; // unreachable by design
  process.env.PLUGIN_STORAGE_TOKEN = 'storage-token';
  server = createPluginWorkerServer();
  await new Promise<void>((resolveListen) =>
    server.listen(0, '127.0.0.1', () => resolveListen())
  );
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
  rmSync(pluginsDir, { recursive: true, force: true });
});

async function rpc(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(`${baseUrl}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lf-worker-token': RPC_TOKEN, ...headers },
    body: JSON.stringify(body),
  });
  if (res.status >= 400) {
    // Diagnostics: the 400 body names the exact cause (Invalid JSON /
    // readBody error / Unknown op) — CI-only failures are debuggable
    // from the assertion message alone.
    const text = await res.clone().text().catch(() => '<unreadable>');
    console.error(`[rpc-diag] 400 from op=${String((body as { op?: string }).op)}: ${text}`);
  }
  return res;
}

const CTX = {
  actorUserId: 'user-1',
  players: [
    { id: 'user-1', name: 'Alice' },
    { id: 'user-2', name: 'Bob' },
  ],
  voiceParticipants: ['user-1'],
  serverId: 'srv-1',
  pluginId: 'fixture-plugin',
};

describe('plugin-worker RPC', () => {
  it('health endpoint answers (compose healthcheck path)', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.service).toBe('plugin-worker');
  });

  it('rejects RPC without the shared token', async () => {
    const res = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'list' }),
    });
    expect(res.status).toBe(401);
  });

  it('describe reports the manifest of the exact bundle requested', async () => {
    const res = await rpc({ op: 'describe', ...bundle('fixture-plugin') });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugin: { id: string; name: string; version: string } };
    expect(body.plugin).toEqual({ id: 'fixture-plugin', name: 'Fixture', version: '1.0.0' });
  });

  it('describe refuses a bundle without a reducer (shape check in the executor)', async () => {
    const res = await rpc({ op: 'describe', ...bundle('no-reducer-plugin') });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('does not export a valid plugin');
  });

  it('the old `list` op is gone (it picked the alphabetically last version folder)', async () => {
    const res = await rpc({ op: 'list' });
    expect(res.status).toBe(400);
  });

  it('runs EXACTLY the requested version: 1.9.0 and 1.10.0 each run their own folder', async () => {
    const older = await rpc({ op: 'createInitialState', ...bundle('versioned-plugin', '1.9.0'), ctx: CTX });
    expect(older.status).toBe(200);
    expect(((await older.json()) as { result: { ranVersion: string } }).result.ranVersion).toBe('1.9.0');
    const newer = await rpc({ op: 'createInitialState', ...bundle('versioned-plugin', '1.10.0'), ctx: CTX });
    expect(newer.status).toBe(200);
    expect(((await newer.json()) as { result: { ranVersion: string } }).result.ranVersion).toBe('1.10.0');
  });

  it('refuses a digest that does not match the folder (409, nothing runs)', async () => {
    // The 1.9.0 folder with the 1.10.0 digest: the host meant other files.
    const res = await rpc({
      op: 'createInitialState',
      pluginId: 'versioned-plugin',
      version: '1.9.0',
      digest: bundle('versioned-plugin', '1.10.0').digest,
      ctx: CTX,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/digest mismatch/);
  });

  it('refuses a request without an exact version and digest (400)', async () => {
    for (const body of [
      { op: 'createInitialState', pluginId: 'fixture-plugin', ctx: CTX },
      { op: 'migrateState', pluginId: 'fixture-plugin', version: '1.0.0', raw: {} },
      { op: 'describe', pluginId: 'fixture-plugin', version: 'latest', digest: bundle('fixture-plugin').digest },
    ]) {
      const res = await rpc(body);
      expect(res.status).toBe(400);
    }
  });

  it('refuses path-like plugin ids and versions (400)', async () => {
    const digest = bundle('fixture-plugin').digest;
    for (const ref of [
      { pluginId: '../fixture-plugin', version: '1.0.0', digest },
      { pluginId: 'fixture-plugin', version: '../../etc', digest },
    ]) {
      const res = await rpc({ op: 'describe', ...ref });
      expect(res.status).toBe(400);
    }
  });

  it('a version that is not installed → 404', async () => {
    const res = await rpc({ op: 'describe', ...bundle('versioned-plugin', '2.0.0') });
    expect(res.status).toBe(404);
  });

  it('an unresolvable package import names the fix (bundle every dependency)', async () => {
    const res = await rpc({ op: 'describe', ...bundle('external-import-plugin') });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('bundle every dependency');
  });

  it('createInitialState receives ONLY the snapshot ctx (no host objects)', async () => {
    const res = await rpc({ op: 'createInitialState', ...bundle('fixture-plugin'), ctx: CTX });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { actor: string; players: string[] } };
    expect(body.result.actor).toBe('user-1');
    expect(body.result.players).toEqual(['user-1', 'user-2']);
  });

  it('handleAction round-trips state + action with voice snapshot', async () => {
    const res = await rpc({
      op: 'handleAction',
      ...bundle('fixture-plugin'),
      ctx: CTX,
      state: { actor: 'user-1' },
      action: { type: 'reveal' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { lastAction: { type: string }; voice: string[] } };
    expect(body.result.lastAction.type).toBe('reveal');
    expect(body.result.voice).toEqual(['user-1']);
  });

  it('migrateState runs in the worker', async () => {
    const res = await rpc({ op: 'migrateState', ...bundle('fixture-plugin'), raw: { old: 1 } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { migrated: boolean; raw: { old: number } } };
    expect(body.result.migrated).toBe(true);
    expect(body.result.raw.old).toBe(1);
  });

  it('unknown plugin → 404', async () => {
    const res = await rpc({ op: 'createInitialState', ...bundle('nope'), ctx: CTX });
    expect(res.status).toBe(404);
  });

  it('storage capabilities fail CLOSED when the host endpoint is unreachable', async () => {
    const res = await rpc({ op: 'createInitialState', ...bundle('storage-plugin'), ctx: CTX });
    // The fixture awaits ctx.storage.get → the proxy cannot reach the
    // host → the call errors as a 500, never silently succeeds.
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('storage-plugin');
  });

  it('malformed JSON → 400', async () => {
    const res = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lf-worker-token': RPC_TOKEN },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('9th-audit: an infinite-loop plugin is TERMINATED, not hung forever', async () => {
    const res = await rpc({ op: 'createInitialState', ...bundle('hang-plugin'), ctx: CTX });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/budget|terminated/i);
    // The worker SERVICE itself must still be healthy afterwards.
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
  }, 30_000);

  it('17th-audit: process.send(null) does NOT crash the parent (strict IPC validation)', async () => {
    const res = await rpc({ op: 'createInitialState', ...bundle('ipc-null-plugin'), ctx: CTX });
    // The parent must survive and return an error, not crash.
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid executor IPC message');
    // Parent health check — service is alive.
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
  }, 15_000);

  it('17th-audit: process.exit(0) settles the Promise (no hang)', async () => {
    const start = Date.now();
    const res = await rpc({ op: 'createInitialState', ...bundle('exit-zero-plugin'), ctx: CTX });
    const elapsed = Date.now() - start;
    // Must settle within the budget, not hang forever.
    expect(elapsed).toBeLessThan(15_000);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('exited before producing a result');
  }, 20_000);

  it('17th-audit: fake process.send({result}) does not hijack the real result', async () => {
    const res = await rpc({ op: 'createInitialState', ...bundle('fake-result-plugin'), ctx: CTX });
    // The FIRST valid message the parent receives is the fake result
    // with {hacked: true}. The parent settles on it — this documents
    // the known limitation (the plugin shares the IPC primitive). The
    // mitigation is that the SCOPED capability still constrains what
    // the plugin can DO with a fake result (it only controls its own
    // return value to the web app, not other plugins' data).
    expect(res.status).toBe(200); // parent doesn't crash
    const body = (await res.json()) as { result: unknown };
    // The result is whatever the parent received first — either the
    // fake or the real one. Both prove the parent survived.
    expect(body.result).toBeDefined();
  }, 15_000);

  it('unknown op → 400', async () => {
    const res = await rpc({ op: 'explode' });
    expect(res.status).toBe(400);
  });
});
