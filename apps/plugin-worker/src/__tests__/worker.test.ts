/**
 * LF-SEC-010: the isolated plugin-worker runtime. These tests spin the
 * REAL HTTP server on an ephemeral port with a temp plugins directory
 * containing a fixture bundle, and drive it with real fetch calls —
 * the same path the web app's client takes in production.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginWorkerServer } from '../index.js';

const RPC_TOKEN = 'test-worker-token';

let server: ReturnType<typeof createPluginWorkerServer>;
let baseUrl: string;
let pluginsDir: string;

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

function writePlugin(id: string, body: string): void {
  const dir = join(pluginsDir, id, '1.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.js'), body);
}

beforeAll(async () => {
  pluginsDir = mkdtempSync(join(tmpdir(), 'lf-plugin-worker-'));
  writePlugin('fixture-plugin', FIXTURE_PLUGIN);
  writePlugin('storage-plugin', STORAGE_PLUGIN);
  process.env.PLUGINS_DIR = pluginsDir;
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
  if (res.status === 400) {
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

  it('lists warmed plugins with manifest metadata', async () => {
    const res = await rpc({ op: 'list' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: Array<{ id: string; name: string }> };
    const ids = body.plugins.map((p) => p.id).sort();
    expect(ids).toEqual(['fixture-plugin', 'storage-plugin']);
  });

  it('createInitialState receives ONLY the snapshot ctx (no host objects)', async () => {
    const res = await rpc({ op: 'createInitialState', pluginId: 'fixture-plugin', ctx: CTX });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { actor: string; players: string[] } };
    expect(body.result.actor).toBe('user-1');
    expect(body.result.players).toEqual(['user-1', 'user-2']);
  });

  it('handleAction round-trips state + action with voice snapshot', async () => {
    const res = await rpc({
      op: 'handleAction',
      pluginId: 'fixture-plugin',
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
    const res = await rpc({ op: 'migrateState', pluginId: 'fixture-plugin', raw: { old: 1 } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { migrated: boolean; raw: { old: number } } };
    expect(body.result.migrated).toBe(true);
    expect(body.result.raw.old).toBe(1);
  });

  it('unknown plugin → 404', async () => {
    const res = await rpc({ op: 'createInitialState', pluginId: 'nope', ctx: CTX });
    expect(res.status).toBe(404);
  });

  it('storage capabilities fail CLOSED when the host endpoint is unreachable', async () => {
    const res = await rpc({ op: 'createInitialState', pluginId: 'storage-plugin', ctx: CTX });
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

  it('unknown op → 400', async () => {
    const res = await rpc({ op: 'explode' });
    expect(res.status).toBe(400);
  });
});
