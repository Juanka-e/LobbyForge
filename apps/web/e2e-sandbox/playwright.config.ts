import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The sandboxed plugin frame in a real browser, WITHOUT Docker (ADR-007).
 *
 *   cd apps/web && npx playwright test -c e2e-sandbox/playwright.config.ts
 *
 * Boots `next dev` on its own port against a throw-away install root holding
 * "installed" marketplace plugins: a probe that attacks the sandbox from the
 * inside, the sandbox-buzzer example's UI, and — phase 2 of the plugin
 * unlock — a files-mode probe with one approved outside origin and plugins
 * whose UI is their author's own site. Those sites are served by a second
 * process (fixtures/external-site/server.mjs) on 127.0.0.1, a host the app
 * (localhost) is not on. The real asset route, middleware and next.config
 * answer, so the headers under test are the ones production sends. Kept out
 * of ./e2e on purpose: that suite runs against the Docker stack, where these
 * fixtures are not installed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
export const PORT = 19598;
/** The author's site of an external UI, and an approved API (fixtures/external-site). */
export const SITE = 'http://127.0.0.1:19599';
/** Another site: an impostor page, and an API that was asked for but not approved. */
export const OTHER_SITE = 'http://127.0.0.1:19600';
/** A site an external UI asked for and the owner never approved. */
export const PENDING_SITE = 'http://127.0.0.1:19601';
// Inside the checkout (gitignored), not the shared OS temp dir, where
// another user could plant files before this run writes its own.
export const INSTALL_DIR = join(here, '.install');
const DIGEST = '0'.repeat(64);
const SERVER_JS = 'globalThis.plugin = { createInitialState: function () { return {}; }, handleAction: function (c, s) { return s; } };';

/** The active record, with what the owner approved at install (plugin-approvals.ts). */
function activate(pluginId: string, version: string, approved?: Record<string, unknown>) {
  writeFileSync(
    join(INSTALL_DIR, pluginId, 'active.json'),
    JSON.stringify({ version, digest: DIGEST, ...(approved ? { approved } : {}) })
  );
}

/** A sandbox-v1 bundle as the installer leaves it (the route re-validates it). */
function installUi(
  pluginId: string,
  version: string,
  manifest: Record<string, unknown>,
  serverJs: string,
  uiSource: string,
  localesSource?: string,
  approved?: Record<string, unknown>
) {
  const versionDir = join(INSTALL_DIR, pluginId, version);
  mkdirSync(join(versionDir, 'ui'), { recursive: true });
  writeFileSync(join(versionDir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(versionDir, 'server.js'), serverJs);
  cpSync(uiSource, join(versionDir, 'ui'), { recursive: true });
  // The bundle's translation tables (validated with the manifest on every read).
  if (localesSource) cpSync(localesSource, join(versionDir, 'locales'), { recursive: true });
  activate(pluginId, version, approved);
}

/** A bundle whose UI is its author's own page (`ui: { url }`): no ui/ folder. */
function installExternal(pluginId: string, url: string, approved: boolean) {
  const versionDir = join(INSTALL_DIR, pluginId, '1.0.0');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    join(versionDir, 'manifest.json'),
    JSON.stringify({ id: pluginId, name: pluginId, version: '1.0.0', sdk: 'sandbox-v1', ui: { url }, actionPolicies: {} })
  );
  writeFileSync(join(versionDir, 'server.js'), SERVER_JS);
  activate(pluginId, '1.0.0', approved ? { uiUrl: url } : undefined);
}

// Idempotent (overwrites with the same bytes): the config is evaluated again
// in every worker while the server is already running.
const vendoredClient = join(repoRoot, 'examples', 'plugins', 'sandbox-buzzer', 'ui', 'lobbyforge-frame.js');
installUi(
  'probe',
  '1.0.0',
  { id: 'probe', name: 'Probe', version: '1.0.0', sdk: 'sandbox-v1', ui: true, actionPolicies: {} },
  SERVER_JS,
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
  join(buzzerDir, 'ui'),
  join(buzzerDir, 'locales')
);

// Phase 2. Its own files, asking for two outside APIs; the owner approved one.
installUi(
  'net-probe',
  '1.0.0',
  {
    id: 'net-probe',
    name: 'Net probe',
    version: '1.0.0',
    sdk: 'sandbox-v1',
    ui: true,
    actionPolicies: {},
    network: { connect: [SITE, OTHER_SITE] },
  },
  SERVER_JS,
  join(here, 'fixtures', 'net-probe', 'ui'),
  undefined,
  { network: { connect: [SITE] } }
);
cpSync(vendoredClient, join(INSTALL_DIR, 'net-probe', '1.0.0', 'ui', 'lobbyforge-frame.js'));
// UIs on their authors' sites: approved, approved (the impostor's site), never approved.
export const SITE_UI = `${SITE}/play`;
installExternal('ext-probe', SITE_UI, true);
installExternal('ext-other', `${OTHER_SITE}/impostor`, true);
installExternal('ext-pending', `${PENDING_SITE}/`, false);

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
  webServer: [
    {
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
        // The public origin: the frame's fetch() and media reach only the
        // plugin's own folder on it (lib/plugin-ui-assets.ts).
        LOBBYFORGE_APP_ORIGIN: `http://localhost:${PORT}`,
        // Development and tests only: http: and local hosts in `network` and
        // `ui.url` (the outside sites above). Ignored in production.
        LOBBYFORGE_PLUGIN_ALLOW_LOCAL_ORIGINS: 'true',
        // The app refuses to boot without a real session secret (security
        // review INFRA-V-02, instrumentation.ts) — a fresh one per run.
        LOBBYFORGE_SESSION_SECRET: process.env.LOBBYFORGE_SESSION_SECRET || randomBytes(32).toString('hex'),
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
    {
      command: 'node e2e-sandbox/fixtures/external-site/server.mjs',
      cwd: resolve(here, '..'),
      url: `${SITE}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
