/**
 * ADR-007, the web side of the worker bridge (plugin-worker-client.ts):
 * action policies come from the manifest the web app reads and validates
 * itself — a worker that reports other policies is refused, so a VM escape
 * cannot widen who may send which action — and the worker-backed plugin
 * exposes only the functions server.js defines.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GamePluginContext } from '@lobbyforge/plugin-sdk';
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';
import { pollPlugin } from '@lobbyforge/poll';
import {
  attachSandboxScope,
  buildWorkerPlugin,
  describeWorkerPlugin,
  isWorkerBackedPlugin,
  type WorkerPluginInfo,
} from '../plugin-worker-client';
import { ProjectionCache, pluginProjectsState, projectStateForViewer, sandboxLocaleFor } from '../plugin-projection';

const DIGEST = 'f'.repeat(64);
const POLICIES = { buzz: { role: 'member', actorFields: ['playerId'], joinsRoster: true }, reset: { role: 'host' } };

let root: string;
const calls: Array<Record<string, unknown>> = [];
let describeReply: Record<string, unknown>;

function writeBundle(manifest: Record<string, unknown>): void {
  const dir = join(root, 'buzzer', '1.2.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'server.js'), 'globalThis.plugin = {};');
}

const MANIFEST = { id: 'buzzer', name: 'Buzzer', version: '1.2.0', sdk: 'sandbox-v1', ui: true, actionPolicies: POLICIES, maxPlayers: 20 };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lf-worker-client-'));
  writeBundle(MANIFEST);
  mkdirSync(join(root, 'buzzer', '1.2.0', 'ui'), { recursive: true });
  writeFileSync(join(root, 'buzzer', '1.2.0', 'ui', 'index.html'), '<!doctype html>');
  calls.length = 0;
  describeReply = {
    plugin: { ...MANIFEST, locales: ['en'], hasValidateAction: true, hasProjection: true, hasMigrateState: false },
  };
  vi.stubEnv('LOBBYFORGE_PLUGIN_WORKER_URL', 'http://plugin-worker:7101');
  vi.stubEnv('LOBBYFORGE_PLUGIN_WORKER_TOKEN', 'token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      const payload =
        body.op === 'describe'
          ? describeReply
          : body.op === 'handleAction'
            ? { unchanged: true }
            : body.op === 'validateAction'
              ? { result: 'nope' }
              : { result: { projectedFor: body.viewerId } };
      return new Response(JSON.stringify(payload), { status: 200 });
    })
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

const REF = { pluginId: 'buzzer', version: '1.2.0', digest: DIGEST };

describe('describeWorkerPlugin', () => {
  it('takes the policies from the manifest on disk and the function flags from the worker', async () => {
    const info = await describeWorkerPlugin(REF, root);
    expect(calls).toEqual([{ op: 'describe', ...REF }]);
    expect(info).toEqual({
      id: 'buzzer',
      name: 'Buzzer',
      version: '1.2.0',
      digest: DIGEST,
      sdk: 'sandbox-v1',
      actionPolicies: POLICIES,
      locales: ['en'],
      ui: true,
      maxPlayers: 20,
      hasValidateAction: true,
      hasProjection: true,
      hasMigrateState: false,
    });
  });

  it('refuses a worker that reports wider policies than the manifest (a VM escape cannot grant roles)', async () => {
    describeReply = {
      plugin: { ...(describeReply.plugin as object), actionPolicies: { ...POLICIES, reset: { role: 'member' } } },
    };
    await expect(describeWorkerPlugin(REF, root)).rejects.toThrow(/different action policies/);
  });

  it('refuses a worker that loaded another version or another sdk', async () => {
    describeReply = { plugin: { ...(describeReply.plugin as object), version: '1.1.0' } };
    await expect(describeWorkerPlugin(REF, root)).rejects.toThrow(/different bundle/);
  });

  it('an invalid manifest on disk fails before the worker is asked', async () => {
    writeBundle({ ...MANIFEST, actionPolicies: { buzz: { role: 'admin' } } });
    await expect(describeWorkerPlugin(REF, root)).rejects.toThrow(/role must be/);
    expect(calls).toHaveLength(0);
  });
});

function info(overrides: Partial<WorkerPluginInfo> = {}): WorkerPluginInfo {
  return {
    id: 'buzzer',
    name: 'Buzzer',
    version: '1.2.0',
    digest: DIGEST,
    sdk: 'sandbox-v1',
    actionPolicies: POLICIES as WorkerPluginInfo['actionPolicies'],
    locales: ['en'],
    ui: true,
    hasValidateAction: false,
    hasProjection: false,
    hasMigrateState: false,
    ...overrides,
  };
}

describe('buildWorkerPlugin', () => {
  it('exposes only the functions server.js defines', () => {
    const bare = buildWorkerPlugin(info());
    expect(isWorkerBackedPlugin(bare)).toBe(true);
    expect(bare.validateAction).toBeUndefined();
    expect(bare.migrateState).toBeUndefined();
    expect(bare.projectState).toBeUndefined();
    expect(bare.hasProjection).toBe(false);
    expect(pluginProjectsState(bare)).toBe(false);
    const full = buildWorkerPlugin(info({ hasValidateAction: true, hasProjection: true, hasMigrateState: true }));
    expect(typeof full.validateAction).toBe('function');
    expect(typeof full.migrateState).toBe('function');
    expect(typeof full.projectState).toBe('function');
    expect(pluginProjectsState(full)).toBe(true);
    expect(full.actionPolicies).toEqual(POLICIES);
    expect(full.manifest.catalog).toBeUndefined();
    expect(buildWorkerPlugin(info({ maxPlayers: 8 })).manifest.catalog).toEqual({ playerConfig: { minPlayers: undefined, maxPlayers: 8 } });
  });

  it('a refused action (worker: unchanged) returns the SAME state object, and the ctx carries the sandbox scope', async () => {
    const plugin = buildWorkerPlugin(info());
    const ctx = createTestHarness({ plugin: pollPlugin, players: ['u-1', 'u-2'] }).context as unknown as GamePluginContext;
    Object.defineProperty(ctx, '__lfScope', { value: { serverId: 'srv-1', pluginId: 'buzzer' } });
    attachSandboxScope(ctx, { sessionId: 'sess-9', hostUserId: 'u-host', locale: 'tr', now: 1234 });
    const state = { a: 1 };
    expect(await plugin.handleAction(ctx, state, { type: 'buzz' })).toBe(state);
    expect(calls[0]).toMatchObject({
      op: 'handleAction',
      ...REF,
      ctx: { sessionId: 'sess-9', serverId: 'srv-1', hostId: 'u-host', locale: 'tr', now: 1234 },
    });
    expect((calls[0]!.ctx as { players: unknown[] }).players).toHaveLength(2);
  });

  it('validateAction and projectState are RPCs', async () => {
    const plugin = buildWorkerPlugin(info({ hasValidateAction: true, hasProjection: true }));
    expect(await plugin.validateAction!({ type: 'x' })).toBe('nope');
    expect(await plugin.projectState!({ s: 1 }, 'u-2', { sessionId: 's', serverId: 'v', hostUserId: null, now: 5 })).toEqual({
      projectedFor: 'u-2',
    });
    expect(calls[1]).toMatchObject({ op: 'projectState', viewerId: 'u-2', ctx: { sessionId: 's', serverId: 'v', hostId: null, now: 5 } });
  });
});

describe('projectStateForViewer', () => {
  const ctx = { sessionId: 's', serverId: 'v', hostUserId: null };

  it('caches one projection per revision and viewer, and forgets failures', async () => {
    const plugin = buildWorkerPlugin(info({ hasProjection: true }));
    const cache = new ProjectionCache();
    await projectStateForViewer({ plugin, pluginId: 'buzzer', state: {}, viewerUserId: 'u-1', ctx, cache, revision: 3 });
    await projectStateForViewer({ plugin, pluginId: 'buzzer', state: {}, viewerUserId: 'u-1', ctx, cache, revision: 3 });
    await projectStateForViewer({ plugin, pluginId: 'buzzer', state: {}, viewerUserId: 'u-2', ctx, cache, revision: 3 });
    expect(calls.filter((c) => c.op === 'projectState')).toHaveLength(2);
    const failing = new ProjectionCache();
    let attempts = 0;
    const compute = () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('down')) : Promise.resolve('ok');
    };
    await expect(failing.getOrCompute('k', compute)).rejects.toThrow('down');
    await Promise.resolve();
    expect(await failing.getOrCompute('k', compute)).toBe('ok');
  });

  it('official plugins go through core; an unknown plugin gets null', async () => {
    const official = (await vi.importActual<typeof import('../plugin-registry')>('../plugin-registry')).getPlugin('poll');
    const out = (await projectStateForViewer({
      plugin: official,
      pluginId: 'poll',
      state: { ballotBox: ['u-1'], options: [] },
      viewerUserId: 'u-1',
      ctx,
    })) as Record<string, unknown>;
    expect(out.ballotBox).toBeUndefined();
    expect(out.hasVoted).toBe(true);
    expect(await projectStateForViewer({ plugin: null, pluginId: 'gone', state: { secret: 1 }, viewerUserId: 'u-1', ctx })).toBeNull();
  }, 20_000);
});

describe('sandboxLocaleFor', () => {
  const req = (headers: Record<string, string>) => new Request('http://x/', { headers });
  it('prefers the saved lf_locale, then Accept-Language, then en', () => {
    expect(sandboxLocaleFor(req({ cookie: 'a=1; lf_locale=tr', 'accept-language': 'de-DE' }))).toBe('tr');
    expect(sandboxLocaleFor(req({ 'accept-language': 'pt-BR,pt;q=0.9' }))).toBe('pt-BR');
    expect(sandboxLocaleFor(req({ cookie: 'lf_locale=../../x', 'accept-language': '*' }))).toBe('en');
    expect(sandboxLocaleFor(req({}))).toBe('en');
  });
});
