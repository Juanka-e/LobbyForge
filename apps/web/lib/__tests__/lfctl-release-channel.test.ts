/**
 * `lfctl update check` with no --manifest: the newest release of the
 * channel, looked up through the GitHub API. The final test pass found a
 * 404 — the default was GitHub's /releases/latest, which skips pre-releases,
 * and every release so far is one.
 *
 * Drives the REAL CLI against a local stand-in for the GitHub API
 * (LFCTL_GITHUB_API) that serves a releases listing and the signed
 * manifests its assets point at.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const LFCTL = join(REPO_ROOT, 'scripts', 'lfctl.mjs');

// MUST stay byte-identical to canonicalize() in scripts/lfctl.mjs.
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((key) => key !== 'signature')
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

function signedManifest(version: string): Record<string, unknown> {
  const manifest: Record<string, unknown> = { version, channel: 'stable' };
  manifest.signature = sign(null, Buffer.from(canonicalize(manifest), 'utf8'), privateKey).toString('base64url');
  return manifest;
}

interface FakeRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  /** false: the release carries no release-manifest.json. */
  manifest?: boolean;
  /** Serve this body instead of a correctly signed manifest. */
  body?: Record<string, unknown>;
}

let server: Server;
let api = '';
let dir = '';
let listing: FakeRelease[] = [];
const requested: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lfctl-channel-'));
  writeFileSync(join(dir, 'release-public.pem'), publicKey.export({ format: 'pem', type: 'spki' }));
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requested.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/repos/acme/lobbyforge/releases') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          listing.map((r) => ({
            tag_name: r.tag_name,
            draft: r.draft,
            prerelease: r.prerelease,
            assets:
              r.manifest === false
                ? [{ name: 'SHA256SUMS.txt', browser_download_url: `${api}/download/${r.tag_name}/SHA256SUMS.txt` }]
                : [{ name: 'release-manifest.json', browser_download_url: `${api}/download/${r.tag_name}/release-manifest.json` }],
          }))
        )
      );
      return;
    }
    const download = /^\/download\/([^/]+)\/release-manifest\.json$/.exec(url.pathname);
    const release = download && listing.find((r) => r.tag_name === download[1]);
    if (release) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(release.body ?? signedManifest(release.tag_name.replace(/^v/, ''))));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

/** Async spawn: the stand-in API answers from this same process. */
function check(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LFCTL_ROOT: dir,
      LFCTL_GITHUB_API: api,
      LOBBYFORGE_RELEASE_REPO: 'acme/lobbyforge',
    };
    delete env.LOBBYFORGE_RELEASE_MANIFEST;
    delete env.LOBBYFORGE_RELEASE_PUBLIC_KEY_PEM;
    delete env.LOBBYFORGE_VERSION;
    const child = spawn(
      process.execPath,
      [LFCTL, 'update', 'check', '--json', '--current-version', '0.1.0', '--public-key', 'release-public.pem', ...args],
      { cwd: dir, env }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const BETA_ERA: FakeRelease[] = [
  { tag_name: 'v0.10.0-rc.1', draft: true, prerelease: true }, // a draft never counts
  { tag_name: 'v0.9.0-rc.8', draft: false, prerelease: true, manifest: false }, // no manifest asset
  { tag_name: 'v0.9.0-rc.7', draft: false, prerelease: true },
  { tag_name: 'v0.9.0-rc.6', draft: false, prerelease: true },
];

describe('lfctl update check without --manifest', () => {
  it('--channel beta takes the newest pre-release that carries a manifest (drafts skipped)', async () => {
    listing = BETA_ERA;
    requested.length = 0;
    const res = await check(['--channel', 'beta']);
    expect(res.code, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout) as { latestVersion: string; updateAvailable: boolean; signature: { status: string } };
    expect(out).toMatchObject({ latestVersion: '0.9.0-rc.7', updateAvailable: true, signature: { status: 'valid' } });
    expect(requested).toContain('/repos/acme/lobbyforge/releases?per_page=100');
    expect(requested).toContain('/download/v0.9.0-rc.7/release-manifest.json');
    expect(res.stderr).toContain('v0.9.0-rc.7 (pre-release)');
  });

  it('the stable default skips pre-releases and takes the highest full release', async () => {
    // A backport published after a newer release is listed first; the
    // version decides, not the listing order.
    listing = [
      ...BETA_ERA,
      { tag_name: 'v0.8.1', draft: false, prerelease: false },
      { tag_name: 'v0.9.0', draft: false, prerelease: false },
      { tag_name: 'v0.8.0', draft: false, prerelease: false },
    ];
    const res = await check([]);
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ latestVersion: '0.9.0' });
  });

  it('stable with only pre-releases published: a clear error that names --channel beta', async () => {
    listing = BETA_ERA;
    const res = await check([]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('No stable release');
    expect(res.stderr).toContain('v0.9.0-rc.7');
    expect(res.stderr).toContain('--channel beta');
  });

  it('the manifest found this way is still verified: a forged one fails closed', async () => {
    listing = [
      { tag_name: 'v0.9.0-rc.9', draft: false, prerelease: true, body: { version: '0.9.0-rc.9', channel: 'stable', signature: 'AAAA' } },
      ...BETA_ERA,
    ];
    const res = await check(['--channel', 'beta']);
    expect(res.code).toBe(2);
    expect(JSON.parse(res.stdout)).toMatchObject({ latestVersion: '0.9.0-rc.9', signature: { status: 'invalid' } });
    expect(res.stderr).toContain('refusing to trust this release source');
  });
});
