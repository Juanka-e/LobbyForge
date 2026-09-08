/**
 * SEC-008: the dynamic plugin loader must stay CLOSED by default.
 *
 * Marketplace bundles are third-party code and the execution model is
 * in-process (no sandbox) — the flag LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED
 * is the single boot-time gate. These tests pin BOTH gates so neither
 * can be quietly weakened:
 *   1. warmInstalledPlugins() must not touch the filesystem at all
 *      when the flag is unset (the install API's 503 is pinned in
 *      marketplace/install/__tests__/install.test.ts).
 *   2. reloadDynamicPlugin() resolves false without the flag.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => [] as string[]),
  statSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, ...fsMocks };
});

// LF-SEC-010: worker-runtime client mock.
const workerMocks = vi.hoisted(() => ({
  listWorkerPlugins: vi.fn(),
  buildWorkerPlugin: vi.fn((info: { id: string; name: string }) => ({
    manifest: { id: info.id, name: info.name },
    __workerBacked: true,
  })),
  workerRuntimeConfigured: vi.fn(() => false),
}));
vi.mock('../plugin-worker-client', () => workerMocks);

describe('plugin-loader SEC-008 gate', () => {
  const realEnv = process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED;

  beforeEach(() => {
    vi.resetModules();
    fsMocks.existsSync.mockClear().mockReturnValue(false);
    fsMocks.readdirSync.mockClear().mockReturnValue([]);
    fsMocks.statSync.mockClear();
    delete process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED;
  });

  it('warmInstalledPlugins performs NO filesystem access without the flag', async () => {
    const { warmInstalledPlugins, listDynamicPluginIds } = await import('../plugin-loader');
    await warmInstalledPlugins();

    expect(fsMocks.existsSync).not.toHaveBeenCalled();
    expect(fsMocks.readdirSync).not.toHaveBeenCalled();
    expect(listDynamicPluginIds()).toEqual([]);
  });

  it('reloadDynamicPlugin is a no-op without the flag', async () => {
    const { reloadDynamicPlugin } = await import('../plugin-loader');
    await expect(reloadDynamicPlugin('quiz')).resolves.toBe(false);
    expect(fsMocks.existsSync).not.toHaveBeenCalled();
  });

  it('LF-SEC-010: flag ON without the worker URL loads NOTHING (fail closed)', async () => {
    process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'true';
    delete process.env.LOBBYFORGE_PLUGIN_WORKER_URL;
    workerMocks.workerRuntimeConfigured.mockReturnValue(false);
    const { warmInstalledPlugins, listDynamicPluginIds } = await import('../plugin-loader');
    await warmInstalledPlugins();
    expect(workerMocks.listWorkerPlugins).not.toHaveBeenCalled();
    expect(listDynamicPluginIds()).toEqual([]);
    expect(fsMocks.existsSync).not.toHaveBeenCalled();
  });

  it('LF-SEC-010: flag ON + worker URL loads through the ISOLATED worker', async () => {
    process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'true';
    process.env.LOBBYFORGE_PLUGIN_WORKER_URL = 'http://plugin-worker:7101';
    workerMocks.workerRuntimeConfigured.mockReturnValue(true);
    workerMocks.listWorkerPlugins.mockResolvedValue([
      { id: 'market-quiz', name: 'Market Quiz', version: '1.0.0' },
    ]);
    const { warmInstalledPlugins, listDynamicPluginIds } = await import('../plugin-loader');
    await warmInstalledPlugins();
    expect(workerMocks.listWorkerPlugins).toHaveBeenCalled();
    // In-process import is GONE — no filesystem walk at all.
    expect(fsMocks.existsSync).not.toHaveBeenCalled();
    expect(listDynamicPluginIds()).toEqual(['market-quiz']);
  });

  it('LF-SEC-010: an unreachable worker fails CLOSED (no plugins, no throw)', async () => {
    process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'true';
    process.env.LOBBYFORGE_PLUGIN_WORKER_URL = 'http://plugin-worker:7101';
    workerMocks.workerRuntimeConfigured.mockReturnValue(true);
    workerMocks.listWorkerPlugins.mockRejectedValue(new Error('ECONNREFUSED'));
    const { warmInstalledPlugins, listDynamicPluginIds } = await import('../plugin-loader');
    await expect(warmInstalledPlugins()).resolves.toBeUndefined();
    expect(listDynamicPluginIds()).toEqual([]);
  });
});
