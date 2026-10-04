import { defineConfig, devices } from '@playwright/test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The sandboxed plugin frame in a real browser, WITHOUT Docker (ADR-007).
 *
 *   cd apps/web && npx playwright test -c e2e-sandbox/playwright.config.ts
 *
 * Boots `next dev` on its own port against a throw-away install root holding
 * two "installed" marketplace plugins: a probe that attacks the sandbox from
 * the inside, and the sandbox-buzzer example's UI. The real asset route,
 * middleware and next.config answer, so the headers under test are the ones
 * production sends. Kept out of ./e2e on purpose: that suite runs against the
 * Docker stack, where these fixtures are not installed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
export const PORT = 19598;
export const INSTALL_DIR = join(tmpdir(), 'lf-plugin-frame-e2e');
const DIGEST = '0'.repeat(64);

/** A sandbox-v1 bundle as the installer leaves it (the route re-validates it). */
function installUi(
  pluginId: string,
  version: string,
  manifest: Record<string, unknown>,
  serverJs: string,
  uiSource: string
) {
  const versionDir = join(INSTALL_DIR, pluginId, version);
  mkdirSync(join(versionDir, 'ui'), { recursive: true });
  writeFileSync(join(versionDir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(versionDir, 'server.js'), serverJs);
  cpSync(uiSource, join(versionDir, 'ui'), { recursive: true });
  writeFileSync(join(INSTALL_DIR, pluginId, 'active.json'), JSON.stringify({ version, digest: DIGEST }));
}

// Idempotent (overwrites with the same bytes): the config is evaluated again
// in every worker while the server is already running.
const vendoredClient = join(repoRoot, 'examples', 'plugins', 'sandbox-buzzer', 'ui', 'lobbyforge-frame.js');
installUi(
  'probe',
  '1.0.0',
  { id: 'probe', name: 'Probe', version: '1.0.0', sdk: 'sandbox-v1', ui: true, actionPolicies: {} },
  'globalThis.plugin = { createInitialState: function () { return {}; }, handleAction: function (c, s) { return s; } };',
  join(here, 'fixtures', 'probe', 'ui')
);
cpSync(vendoredClient, join(INSTALL_DIR, 'probe', '1.0.0', 'ui', 'lobbyforge-frame.js'));

const buzzerDir = join(repoRoot, 'examples', 'plugins', 'sandbox-buzzer');
const buzzerManifest = JSON.parse(readFileSync(join(buzzerDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
export const BUZZER_VERSION = String(buzzerManifest.version);
installUi(
  'sandbox-buzzer',
  BUZZER_VERSION,
  buzzerManifest,
  readFileSync(join(buzzerDir, 'server.js'), 'utf8'),
  join(buzzerDir, 'ui')
);

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec next dev --port ${PORT}`,
    cwd: resolve(here, '..'),
    // Also compiles the route before the first test.
    url: `http://localhost:${PORT}/api/plugin-ui/probe/1.0.0/dot.svg`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      LOBBYFORGE_PLUGIN_INSTALL_DIR: INSTALL_DIR,
      LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED: 'true',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
