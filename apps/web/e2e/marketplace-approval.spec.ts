/**
 * A marketplace install that asks for more than the sandbox, end to end
 * through the REAL routes (docs/PLUGIN_UNLOCK_PLAN.md, plugin-approvals.ts):
 *
 *   1. a publisher's bundle (the sandbox-buzzer example under a fresh id: it
 *      asks for `timers` + `storage`) is submitted and approved by review —
 *      the review route downloads it and pins its SHA-256;
 *   2. before review an install is refused (403); after review an install
 *      without an approval is refused with 409 `approval_required` naming
 *      what the bundle asks for, and an approval that names less is refused
 *      the same way;
 *   3. the owner presses Install on the marketplace page: the approval
 *      dialog lists both host effects in plain words; "Approve and install"
 *      installs it;
 *   4. the install record (`active.json` in the plugin volume) carries
 *      `approved: { permissions: [storage, timers] }`, the plugin is offered
 *      to the community and its frame is served;
 *   5. installing the same version again asks again (every install carries
 *      its approval), with nothing marked new; approving it keeps the record.
 *
 * The installer only downloads https:// URLs whose host resolves to a public
 * address. infra/docker/docker-compose.e2e-bundles.yml provides one inside
 * Docker (a CA-signed bundle host on an internal network with a
 * public-looking subnet); this spec writes its bundle into that host's
 * folder (LF_E2E_BUNDLE_DIR, default infra/docker/.e2e-bundles) and skips
 * when the host or the plugin worker is not running.
 *
 * Screenshots of the dialog (dark and light) go to LF_E2E_SHOTS_DIR when
 * set, else the test's output directory.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';
import { clearRateLimitBuckets, resetRateLimits, signIn } from './helpers/auth';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const shotsDir = process.env.LF_E2E_SHOTS_DIR ?? '';
const ORIGIN = { Origin: baseUrl };
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const BUNDLE_DIR = process.env.LF_E2E_BUNDLE_DIR ? resolve(process.env.LF_E2E_BUNDLE_DIR) : join(repoRoot, 'infra', 'docker', '.e2e-bundles');
const BUNDLE_HOST = 'https://bundles.lobbyforge-e2e.test:8443';
const WEB_CONTAINER = 'lobbyforge-e2e-web';
const PLUGIN_ID = `approval-buzzer-${RUN}`;
const PLUGIN_NAME = `Approval Buzzer ${RUN.slice(-4)}`;
const VERSION = '0.2.0';
const REQUESTED = { permissions: ['storage', 'timers'] };

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'serial', timeout: 120_000 });

function containerHealth(name: string): string {
  try {
    return execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', name], { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    return 'missing';
  }
}

/** Pack the sandbox-buzzer example under PLUGIN_ID into the bundle host's folder; returns the tarball's sha256. */
function publishBundle(): { url: string; sha256: string } {
  const source = join(repoRoot, 'examples', 'plugins', 'sandbox-buzzer');
  const work = mkdtempSync(join(tmpdir(), 'lf-approval-'));
  try {
    for (const entry of ['manifest.json', 'server.js', 'ui', 'locales']) cpSync(join(source, entry), join(work, entry), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(work, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.version).toBe(VERSION);
    expect(manifest.permissions).toEqual(['timers', 'storage']);
    writeFileSync(join(work, 'manifest.json'), JSON.stringify({ ...manifest, id: PLUGIN_ID, name: PLUGIN_NAME }, null, 2));
    const out = execFileSync('node', [join(source, 'pack.mjs'), work, '--out', join(BUNDLE_DIR, 'files')], { encoding: 'utf8' });
    const summary = JSON.parse(out) as { sha256?: string };
    const file = `${PLUGIN_ID}-${VERSION}.tgz`;
    expect(existsSync(join(BUNDLE_DIR, 'files', file))).toBe(true);
    return { url: `${BUNDLE_HOST}/${file}`, sha256: summary.sha256 ?? '' };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function readActiveRecord(): Record<string, unknown> {
  const raw = execFileSync('docker', ['exec', WEB_CONTAINER, 'cat', `/app/plugins/installed/${PLUGIN_ID}/active.json`], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return JSON.parse(raw) as Record<string, unknown>;
}

test.describe('marketplace: an install that needs the owner\'s approval', () => {
  let browser: Browser;
  let owner: APIRequestContext;
  let serverId = '';
  let bundle = { url: '', sha256: '' };

  const install = (approve?: unknown) => {
    // 5 installs a minute per address: this spec makes eight.
    clearRateLimitBuckets(['marketplace-install']);
    return owner.post('/api/marketplace/install', { headers: ORIGIN, data: approve === undefined ? { pluginId: PLUGIN_ID } : { pluginId: PLUGIN_ID, approve } });
  };

  test.beforeAll(async ({ playwright }) => {
    test.skip(containerHealth('lobbyforge-e2e-bundle-host') !== 'healthy', 'No bundle host: start the stack with docker-compose.e2e-bundles.yml (see its header).');
    test.skip(containerHealth('lobbyforge-e2e-plugin-worker') !== 'healthy', 'No plugin worker: start the stack with docker-compose.e2e-plugins.yml.');
    test.skip(!existsSync(join(BUNDLE_DIR, 'files')), `No bundle folder at ${BUNDLE_DIR}: run infra/docker/e2e-bundle-host.sh.`);
    resetRateLimits();
    // WITHOUT --disable-web-security: it drops the Origin header and the CSRF guard refuses the page's POSTs.
    browser = await playwright.chromium.launch({ args: [] });
    owner = await playwright.request.newContext({ baseURL: baseUrl, extraHTTPHeaders: ORIGIN });
    expect((await signIn(owner, { data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } })).status()).toBe(200);
    const { servers } = (await (await owner.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
    serverId = servers[0]!.id;
    bundle = publishBundle();
  });

  test.afterAll(async () => {
    await owner?.dispose();
    await browser?.close();
    rmSync(join(BUNDLE_DIR, 'files', `${PLUGIN_ID}-${VERSION}.tgz`), { force: true });
    rmSync(join(BUNDLE_DIR, 'files', `${PLUGIN_ID}-${VERSION}.tgz.sha256`), { force: true });
  });

  test('submitted and reviewed: review pins the downloaded bundle; installs before review are refused', async () => {
    const submit = await owner.post('/api/marketplace/submit', {
      headers: ORIGIN,
      data: {
        pluginId: PLUGIN_ID,
        name: PLUGIN_NAME,
        version: VERSION,
        type: 'game',
        summary: 'The buzzer example, asking for timers and storage.',
        publisher: 'E2E Publisher',
        category: 'game',
        permissions: ['timers', 'storage'],
        playerConfig: { minPlayers: 1, maxPlayers: 50 },
        manifestUrl: bundle.url,
        requiresVoiceRoom: true,
      },
    });
    expect(submit.status(), await submit.text()).toBe(201);
    expect(((await submit.json()) as { plugin: { reviewStatus: string } }).plugin.reviewStatus).toBe('pending');

    const early = await install();
    expect(early.status(), await early.text()).toBe(403);

    const review = await owner.post('/api/marketplace/review', {
      headers: ORIGIN,
      data: { pluginId: PLUGIN_ID, decision: 'approved', version: VERSION, note: 'e2e' },
    });
    expect(review.status(), await review.text()).toBe(200);
    // The review downloaded the bundle from the publisher's host and pinned exactly those bytes.
    const pinned = execFileSync(
      'docker',
      ['exec', 'lobbyforge-e2e-postgres', 'psql', '-U', 'lobbyforge', '-d', 'lobbyforge', '-tAc', `select bundle_sha256 from plugin_catalog where plugin_id = '${PLUGIN_ID}'`],
      { encoding: 'utf8', timeout: 15_000 }
    ).trim();
    expect(pinned).toBe(bundle.sha256);
  });

  test('an install without the approval is refused with what the bundle asks for', async () => {
    const bare = await install();
    expect(bare.status(), await bare.text()).toBe(409);
    const body = (await bare.json()) as { code: string; pluginId: string; version: string; requested: unknown; added: unknown; previous: unknown };
    expect(body).toMatchObject({ code: 'approval_required', pluginId: PLUGIN_ID, version: VERSION, requested: REQUESTED, previous: null });
    // A first install: everything it asks for is new.
    expect(body.added).toEqual(REQUESTED);

    // Approving less than it asks for approves nothing.
    const partial = await install({ permissions: ['timers'] });
    expect(partial.status(), await partial.text()).toBe(409);
    expect(((await partial.json()) as { code: string }).code).toBe('approval_required');

    // Nothing reached the install directory.
    expect(() => readActiveRecord()).toThrow();
  });

  test('the owner approves on the marketplace page; the install record carries the approval', async ({}, testInfo) => {
    const ctx = await browser.newContext({ baseURL: baseUrl, locale: 'en-US', viewport: { width: 1280, height: 900 } });
    // The theme is the account's (put back afterwards).
    const { settings } = (await (await owner.get('/api/settings/me')).json()) as { settings: { theme: string } };
    const setTheme = async (theme: string) => {
      const res = await owner.patch('/api/settings/me', { headers: ORIGIN, data: { theme } });
      expect(res.status(), await res.text()).toBe(200);
    };
    try {
      await ctx.addCookies((await owner.storageState()).cookies);
      const page = await ctx.newPage();
      const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: PLUGIN_NAME }) });
      const dialog = page.getByRole('dialog', { name: `${PLUGIN_NAME} asks for more access` });
      const openDialog = async () => {
        clearRateLimitBuckets(['marketplace-install']);
        await card.getByRole('button', { name: 'Install', exact: true }).click();
        await expect(dialog).toBeVisible({ timeout: 20_000 });
      };

      for (const theme of ['dark', 'light'] as const) {
        await setTheme(theme);
        // The search matches names (this run's is unique).
        await page.goto(`/marketplace?q=${encodeURIComponent(PLUGIN_NAME)}`);
        await expect(page.locator('html')).toHaveClass(new RegExp(`lf-theme-${theme}`));
        await expect(card).toBeVisible({ timeout: 20_000 });
        await openDialog();
        await expect(dialog.getByText('On the server, it can')).toBeVisible();
        await expect(dialog.getByText('Act on its own after a delay (timers)')).toBeVisible();
        await expect(dialog.getByText('Keep a little data for this community (up to 64 KiB)')).toBeVisible();
        // A first install: nothing is marked new, and nothing outside is asked for.
        await expect(dialog.getByText('New', { exact: true })).toHaveCount(0);
        await expect(dialog.getByText('It can reach these sites from players’ browsers')).toHaveCount(0);
        await page.waitForTimeout(300);
        await page.screenshot({ path: shotsDir ? join(shotsDir, `marketplace-approval-${theme}.png`) : testInfo.outputPath(`approval-${theme}.png`) });
        // Cancel installs nothing.
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
        expect(() => readActiveRecord()).toThrow();
      }

      await openDialog();
      const installed = page.waitForResponse((res) => res.url().endsWith('/api/marketplace/install') && res.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'Approve and install' }).click();
      const res = await installed;
      expect(res.status(), await res.text()).toBe(200);
      expect(JSON.parse(res.request().postData() ?? '{}')).toEqual({ pluginId: PLUGIN_ID, approve: REQUESTED });
      expect(((await res.json()) as { approved: unknown }).approved).toEqual(REQUESTED);
      await expect(dialog).toBeHidden();
      await expect(card.getByRole('button', { name: 'Installed ✓' })).toBeVisible();
      await page.screenshot({ path: shotsDir ? join(shotsDir, 'marketplace-approval-installed-light.png') : testInfo.outputPath('installed-light.png') });
    } finally {
      await ctx.close();
      await setTheme(settings.theme);
    }

    const record = readActiveRecord();
    expect(record.version).toBe(VERSION);
    expect(record.approved).toEqual(REQUESTED);
    expect(typeof record.approvedAt).toBe('string');
    expect(String(record.digest)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the approved plugin is offered to the community and its frame is served', async () => {
    const { apps } = (await (await owner.get(`/api/servers/${serverId}/apps`)).json()) as { apps: Array<{ id: string }> };
    expect(apps.map((a) => a.id)).toContain(PLUGIN_ID);
    const frame = await owner.get(`/api/plugin-ui/${PLUGIN_ID}`);
    expect(frame.status()).toBe(200);
    expect(((await frame.json()) as { frame: { version: string } }).frame.version).toBe(VERSION);
    const html = await owner.get(`/api/plugin-ui/${PLUGIN_ID}/${VERSION}/index.html`, {
      headers: { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(html.status()).toBe(200);
  });

  test('a reinstall asks again, with nothing new; approving it keeps the record', async () => {
    // Every install carries its approval (nothing is approved silently); the
    // dialog then marks nothing new, because the active version had it all.
    const again = await install();
    expect(again.status(), await again.text()).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'approval_required', requested: REQUESTED, added: null, previous: REQUESTED });
    const approved = await install(REQUESTED);
    expect(approved.status(), await approved.text()).toBe(200);
    expect(((await approved.json()) as { approved: unknown }).approved).toEqual(REQUESTED);
    expect(readActiveRecord().approved).toEqual(REQUESTED);
  });
});
