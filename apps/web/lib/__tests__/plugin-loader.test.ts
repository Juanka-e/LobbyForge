/**
 * SEC-008: the dynamic plugin loader must stay CLOSED by default.
 *
 * Marketplace bundles are third-party code — the flag
 * LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED is the single boot-time gate and the
 * isolated worker is mandatory. These tests pin BOTH gates so neither
 * can be quietly weakened:
 *   1. warmInstalledPlugins() must not touch the install directory at all
 *      when the flag is unset (the install API's 503 is pinned in
 *      marketplace/install/__tests__/install.test.ts).
 *   2. reloadDynamicPlugin() resolves false without the flag.
 * And the version rule: the loader asks the worker for EXACTLY the version
 * (and digest) recorded as active — it never lets anything pick a folder.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const layoutMocks = vi.hoisted(() => ({
  pluginInstallDir: vi.fn(() => '/app/plugins/installed'),
  listActivePlugins: vi.fn(() => [] as Array<{ pluginId: string; version: string; digest: string }>),
  readActivePointer: vi.fn(() => null as null | { pluginId: string; version: string; digest: string }),
}));
vi.mock('../plugin-install-layout', () => layoutMocks);

// LF-SEC-010: worker-runtime client mock.
const workerMocks = vi.hoisted(() => ({
  describeWorkerPlugin: vi.fn(),
  buildWorkerPlugin: vi.fn((info: { id: string; name: string; version: string }) => ({
    manifest: { id: info.id, name: info.name, version: info.version },
    __workerBacked: true,
  })),
  workerRuntimeConfigured: vi.fn(() => false),
}));
vi.mock('../plugin-worker-client', () => workerMocks);

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

describe('plugin-loader SEC-008 gate', () => {
  beforeEach(() => {
    vi.resetModules();
    layoutMocks.listActivePlugins.mockReset().mockReturnValue([]);
    layoutMocks.readActivePointer.mockReset().mockReturnValue(null);
    workerMocks.describeWorkerPlugin.mockReset();
    workerMocks.workerRuntimeConfigured.mockReset().mockReturnValue(false);
    delete process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED;
  });

  it('warmInstalledPlugins reads NOTHING without the flag', async () => {
    const { warmInstalledPlugins, listDynamicPluginIds } = await import('../plugin-loader');
    await warmInstalledPlugins();

    expect(layoutMocks.listActivePlugins).not.toHaveBeenCalled();
    expect(workerMocks.describeWorkerPlugin).not.toHaveBeenCalled();
    expect(listDynamicPluginIds()).toEqual([]);
  });

  it('reloadDynamicPlugin is a no-op without the flag', async () => {
    const { reloadDynamicPlugin } = await import('../plugin-loader');
    await expect(reloadDynamicPlugin('quiz')).resolves.toBe(false);
    expect(layoutMocks.readActivePointer).not.toHaveBeenCalled();
  });

  it('LF-SEC-010: flag ON without the worker URL loads NOTHING (fail closed)', async () => {
    process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'true';
    delete process.env.LOBBYFORGE_PLUGIN_WORKER_URL;
    workerMocks.workerRuntimeConfigured.mockReturnValue(false);
    const { warmInstalledPlugins, listDynamicPluginIds } = await import('../plugin-loader');
    await warmInstalledPlugins();
    expect(workerMocks.describeWorkerPlugin).not.toHaveBeenCalled();
    expect(layoutMocks.listActivePlugins).not.toHaveBeenCalled();
    expect(listDynamicPluginIds()).toEqual([]);
  });

  it('LF-SEC-010: flag ON + worker URL loads the ACTIVE version of each plugin through the worker', async () => {
    process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'true';
    process.env.LOBBYFORGE_PLUGIN_WORKER_URL = 'http://plugin-worker:7101';
    workerMocks.workerRuntimeConfigured.mockReturnValue(true);
    layoutMocks.listActivePlugins.mockReturnValue([
      { pluginId: 'market-quiz', version: '1.10.0', digest: DIGEST_A },
    ]);
    workerMocks.describeWorkerPlugin.mockImplementation(async (ref: { pluginId: string; version: string; digest: string }) => ({
      id: ref.pluginId,
      name: 'Market Quiz',
      version: ref.version,
      digest: ref.digest,
    }));
    const { warmInstalledPlugins, listDynamicPluginIds, getDynamicPlugin } = await import('../plugin-loader');
    await warmInstalledPlugins();
    expect(layoutMocks.listActivePlugins).toHaveBeenCalledWith('/app/plugins/installed');
    // The exact recorded version + digest — never "the latest folder".
    expect(workerMocks.describeWorkerPlugin).toHaveBeenCalledWith({
      pluginId: 'market-quiz',
      version: '1.10.0',
      digest: DIGEST_A,
    });
    expect(listDynamicPluginIds()).toEqual(['market-quiz']);
    expect(getDynamicPlugin('market-quiz')?.manifest.version).toBe('1.10.0');
  });

  it('one bundle the worker refuses does not block the others', async () => {
    process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'true';
    workerMocks.workerRuntimeConfigured.mockReturnValue(true);
    layoutMocks.listActivePlugins.mockReturnValue([
      { pluginId: 'broken', version: '1.0.0', digest: DIGEST_A },
      { pluginId: 'fine', version: '2.0.0', digest: DIGEST_B },
    ]);
    workerMocks.describeWorkerPlugin.mockImplementation(async (ref: { pluginId: string; version: string; digest: string }) => {
      if (ref.pluginId === 'broken') throw new Error('bundle digest mismatch');
      return { id: ref.pluginId, name: 'Fine', version: ref.version, digest: ref.digest };
    });
    const { warmInstalledPlugins, listDynamicPluginIds } = await import('../plugin-loader');
    await warmInstalledPlugins();
    expect(listDynamicPluginIds()).toEqual(['fine']);
  });

  it('LF-SEC-010: an unreachable worker fails CLOSED (no plugins, no throw)', async () => {
    process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'true';
    process.env.LOBBYFORGE_PLUGIN_WORKER_URL = 'http://plugin-worker:7101';
    workerMocks.workerRuntimeConfigured.mockReturnValue(true);
    layoutMocks.listActivePlugins.mockReturnValue([{ pluginId: 'market-quiz', version: '1.0.0', digest: DIGEST_A }]);
    workerMocks.describeWorkerPlugin.mockRejectedValue(new Error('ECONNREFUSED'));
    const { warmInstalledPlugins, listDynamicPluginIds } = await import('../plugin-loader');
    await expect(warmInstalledPlugins()).resolves.toBeUndefined();
    expect(listDynamicPluginIds()).toEqual([]);
  });

  it('reloadDynamicPlugin reloads the recorded version only', async () => {
    process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'true';
    workerMocks.workerRuntimeConfigured.mockReturnValue(true);
    layoutMocks.readActivePointer.mockReturnValue({ pluginId: 'market-quiz', version: '1.10.0', digest: DIGEST_B });
    workerMocks.describeWorkerPlugin.mockImplementation(async (ref: { pluginId: string; version: string; digest: string }) => ({
      id: ref.pluginId, name: 'Market Quiz', version: ref.version, digest: ref.digest,
    }));
    const { reloadDynamicPlugin, getDynamicPlugin } = await import('../plugin-loader');
    await expect(reloadDynamicPlugin('market-quiz')).resolves.toBe(true);
    expect(workerMocks.describeWorkerPlugin).toHaveBeenCalledWith({
      pluginId: 'market-quiz', version: '1.10.0', digest: DIGEST_B,
    });
    expect(getDynamicPlugin('market-quiz')?.manifest.version).toBe('1.10.0');
    // No record → nothing to reload.
    layoutMocks.readActivePointer.mockReturnValue(null);
    await expect(reloadDynamicPlugin('other')).resolves.toBe(false);
  });
});
