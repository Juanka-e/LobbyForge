/**
 * Marketplace plugins name themselves in each viewer's language: the
 * bundle's locales/<code>.json tables, read and validated from the install
 * directory when the plugin loads, are registered with the plugin SDK's
 * locale registry under the plugin's id, so pluginName() / pluginSummary()
 * — what the lobby, the app lists and the marketplace call — return its
 * catalog.name / catalog.summary with no special case. manifest.json's
 * `name` stays the fallback.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeWorkerPlugin, type WorkerPluginInfo } from '../plugin-worker-client';
import { registerDynamicPlugin } from '../plugin-loader';
import { registerSandboxPluginLocales } from '../sandbox-plugin-locales';
import { pluginName, pluginSummary } from '../plugin-catalog-text';
import { listPluginSummaries } from '../plugin-registry';

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(here, '..', '..', '..', '..', 'examples', 'plugins', 'sandbox-buzzer');
const exampleManifest = JSON.parse(readFileSync(join(EXAMPLE, 'manifest.json'), 'utf8')) as {
  id: string;
  name: string;
  version: string;
  actionPolicies: Record<string, unknown>;
};
const EN = JSON.parse(readFileSync(join(EXAMPLE, 'locales', 'en.json'), 'utf8')) as Record<string, string>;
const TR = JSON.parse(readFileSync(join(EXAMPLE, 'locales', 'tr.json'), 'utf8')) as Record<string, string>;
const DIGEST = 'e'.repeat(64);

let root: string;

/** The example bundle as the installer leaves it on disk. */
function installExample(): void {
  const dir = join(root, exampleManifest.id, exampleManifest.version);
  mkdirSync(dir, { recursive: true });
  for (const name of ['manifest.json', 'server.js', 'ui', 'locales']) {
    cpSync(join(EXAMPLE, name), join(dir, name), { recursive: true });
  }
}

function info(overrides: Partial<WorkerPluginInfo>): WorkerPluginInfo {
  return {
    id: 'market-game',
    name: 'Market Game',
    version: '1.0.0',
    digest: DIGEST,
    sdk: 'sandbox-v1',
    actionPolicies: {},
    locales: ['en'],
    ui: false,
    hasValidateAction: false,
    hasProjection: false,
    hasMigrateState: false,
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lf-sandbox-locales-'));
  delete (globalThis as Record<string, unknown>).__lobbyforgeDynamicPlugins__;
  vi.stubEnv('LOBBYFORGE_PLUGIN_WORKER_URL', 'http://plugin-worker:7101');
  vi.stubEnv('LOBBYFORGE_PLUGIN_WORKER_TOKEN', 'token');
  // The worker's describe answer: the same policies as the manifest on disk.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          plugin: {
            id: exampleManifest.id,
            version: exampleManifest.version,
            sdk: 'sandbox-v1',
            actionPolicies: exampleManifest.actionPolicies,
            hasValidateAction: false,
            hasProjection: true,
            hasMigrateState: false,
          },
        }),
        { status: 200 }
      )
    )
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('a marketplace plugin’s name and summary', () => {
  it('come from its bundle’s locales/ tables once it loads (the example: tr, en, and a language it does not ship)', async () => {
    installExample();
    const id = exampleManifest.id;
    // Before it loads, the host knows only the manifest's name.
    registerSandboxPluginLocales(id, undefined);
    expect(pluginName(id, 'tr', exampleManifest.name)).toBe(exampleManifest.name);

    registerDynamicPlugin(await describeWorkerPlugin({ pluginId: id, version: exampleManifest.version, digest: DIGEST }, root));

    expect(pluginName(id, 'tr', exampleManifest.name)).toBe('Buzzer');
    expect(pluginSummary(id, 'tr', null)).toBe(TR['catalog.summary']);
    expect(pluginName(id, 'en', exampleManifest.name)).toBe('Buzzer');
    expect(pluginSummary(id, 'en', null)).toBe(EN['catalog.summary']);
    expect(TR['catalog.summary']).not.toBe(EN['catalog.summary']);
    // A language the bundle does not ship reads its English table, exactly
    // as an official plugin's does.
    expect(pluginName(id, 'de', exampleManifest.name)).toBe('Buzzer');
    expect(pluginSummary(id, 'de', null)).toBe(EN['catalog.summary']);
  });

  it('fall back to manifest.json’s name for a language neither its own nor English covers', () => {
    registerDynamicPlugin(info({ localeTables: { tr: { 'catalog.name': 'Pazar Oyunu', 'catalog.summary': 'Bir oyun.' } } }));
    expect(pluginName('market-game', 'tr', 'Market Game')).toBe('Pazar Oyunu');
    expect(pluginSummary('market-game', 'tr', null)).toBe('Bir oyun.');
    expect(pluginName('market-game', 'en', 'Market Game')).toBe('Market Game');
    expect(pluginName('market-game', 'de', 'Market Game')).toBe('Market Game');
    expect(pluginSummary('market-game', 'de', null)).toBeNull();
  });

  it('a blank translation falls back too', () => {
    registerDynamicPlugin(info({ localeTables: { en: { 'catalog.name': 'Market Game EN' }, tr: { 'catalog.name': ' ' } } }));
    expect(pluginName('market-game', 'tr', 'Market Game')).toBe('Market Game EN');
  });

  it('a new version replaces the old tables, and one without locales/ clears them', () => {
    registerDynamicPlugin(info({ localeTables: { tr: { 'catalog.name': 'Eski Ad', 'catalog.summary': 'Eski.' } } }));
    registerDynamicPlugin(info({ version: '1.1.0', localeTables: { en: { 'catalog.name': 'New Name' } } }));
    expect(pluginName('market-game', 'tr', 'Market Game')).toBe('New Name');
    expect(pluginSummary('market-game', 'tr', 'From the catalogue')).toBe('From the catalogue');
    registerDynamicPlugin(info({ version: '1.2.0' }));
    expect(pluginName('market-game', 'tr', 'Market Game')).toBe('Market Game');
  });

  it('can never rename a compiled-in plugin or rewrite its strings', () => {
    const poll = listPluginSummaries().find((p) => p.id === 'poll')!;
    expect(registerSandboxPluginLocales('poll', { tr: { 'catalog.name': 'Ele geçirildi' } })).toBe(false);
    // The registry refuses an official id outright (official-plugin-ids.ts).
    expect(() =>
      registerDynamicPlugin(info({ id: 'poll', localeTables: { tr: { 'catalog.name': 'Ele geçirildi' }, en: { 'catalog.name': 'Hijacked' } } }))
    ).toThrow(/official/);
    expect(pluginName('poll', 'tr', poll.name)).toBe('Anket');
    expect(pluginName('poll', 'en', poll.name)).toBe('Poll');
  });

  it('are seen by another copy of the catalog-text module (Next evaluates it once per chunk)', async () => {
    registerDynamicPlugin(info({ localeTables: { tr: { 'catalog.name': 'Pazar Oyunu' } } }));
    vi.resetModules();
    const copy = await import('../plugin-catalog-text');
    expect(copy.pluginName('market-game', 'tr', 'Market Game')).toBe('Pazar Oyunu');
  });
});
