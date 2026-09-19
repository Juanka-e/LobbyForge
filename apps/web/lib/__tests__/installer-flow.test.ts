/**
 * V4-003 acceptance tests: the installer must NEVER mutate a live
 * installation before the new certificate actually exists.
 *
 * Runs the REAL install.sh in a sandbox copy of the repo skeleton with a
 * fake `docker` shim on PATH (no real Docker needed). The shim:
 *   - `docker ps --format …`        → controlled by FAKE_DOCKER_PS
 *   - `docker run … certbot …`      → controlled by FAKE_CERTBOT_RC; on
 *     success it materialises the fake live/<domain> certificate dir the
 *     installer checks for
 *   - `docker compose …`            → exit 0
 *
 * Scenarios (from the 4th audit report):
 *   1. first run, stack stopped, certbot OK        → 0, files activated
 *   2. stack RUNNING, SAME domain                  → 0, hashes unchanged, renew hint
 *   3. stack RUNNING, DIFFERENT domain             → 1, hashes unchanged
 *   4. stack stopped, DIFFERENT domain, certbot FAILS → 1, hashes unchanged
 *   5. stack stopped, DIFFERENT domain, certbot OK → 0, files switched
 */
import { spawnSync, execSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..', '..');
const INSTALL_SH = join(REPO_ROOT, 'install.sh');
const RENDER_SH = join(REPO_ROOT, 'scripts', 'render-configs.sh');

const TRACKED = [
  '.env.prod',
  'infra/nginx/conf.d/app.conf',
  'infra/livekit/livekit.yaml',
  'infra/turn/turnserver.conf',
] as const;

const FAKE_DOCKER = `#!/usr/bin/env bash
# Fake docker for installer-flow tests. Behaviour via env:
#   FAKE_DOCKER_PS     -> names printed by 'docker ps --format'
#   FAKE_CERTBOT_RC    -> exit code for 'docker run ... certbot'
set -u
if [ "$1" = "compose" ]; then exit 0; fi
if [ "$1" = "ps" ]; then echo "\${FAKE_DOCKER_PS-}"; exit 0; fi
if [ "$1" = "run" ]; then
  # find -v <hostpath>:/etc/letsencrypt and -d <domain>
  vol=""; dom=""
  args=("$@")
  for ((i=0; i<\${#args[@]}; i++)); do
    case "\${args[\$i]}" in
      -v) vol="\${args[\$((i+1))]%:/etc/letsencrypt}" ;;
      -d) dom="\${args[\$((i+1))]}" ;;
    esac
  done
  rc="\${FAKE_CERTBOT_RC:-0}"
  if [ "$rc" = "0" ] && [ -n "$vol" ] && [ -n "$dom" ]; then
    mkdir -p "$vol/live/$dom"
    echo fake-cert > "$vol/live/$dom/fullchain.pem"
  fi
  exit "$rc"
fi
exit 0
`;

function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-install-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'infra', 'nginx', 'conf.d'), { recursive: true });
  mkdirSync(join(dir, 'infra', 'livekit'), { recursive: true });
  mkdirSync(join(dir, 'infra', 'turn'), { recursive: true });
  mkdirSync(join(dir, 'infra', 'docker'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  copyFileSync(INSTALL_SH, join(dir, 'install.sh'));
  copyFileSync(RENDER_SH, join(dir, 'scripts', 'render-configs.sh'));
  copyFileSync(
    join(REPO_ROOT, 'infra', 'docker', 'docker-compose.prod.yml'),
    join(dir, 'infra', 'docker', 'docker-compose.prod.yml')
  );
  copyFileSync(
    join(REPO_ROOT, 'infra', 'nginx', 'conf.d', 'app.conf.template'),
    join(dir, 'infra', 'nginx', 'conf.d', 'app.conf.template')
  );
  copyFileSync(
    join(REPO_ROOT, 'infra', 'livekit', 'livekit.yaml.template'),
    join(dir, 'infra', 'livekit', 'livekit.yaml.template')
  );
  copyFileSync(
    join(REPO_ROOT, 'infra', 'turn', 'turnserver.conf.template'),
    join(dir, 'infra', 'turn', 'turnserver.conf.template')
  );
  writeFileSync(join(dir, 'bin', 'docker'), FAKE_DOCKER.replace(/\r\n/g, '\n'), {
    mode: 0o755,
  });
  chmodSync(join(dir, 'bin', 'docker'), 0o755);
  return dir;
}

interface InstallerOpts {
  stackRunning?: boolean;
  certbotRc?: number;
}

/** Runs install.sh with the fake-docker bin prepended to PATH (POSIX ':'). */
function runInstallerPosix(
  sandbox: string,
  domain: string,
  opts: InstallerOpts = {},
  extraInput = ''
) {
  const answers = `${domain}\nE2E Community\nn\nY\n${extraInput}`;
  const res = spawnSync('bash', ['-c', `cd "$1" && PATH="$2:$PATH" FAKE_DOCKER_PS="$3" FAKE_CERTBOT_RC="$4" bash ./install.sh`, 'run', sandbox, join(sandbox, 'bin'), opts.stackRunning ? 'lobbyforge-nginx' : '', String(opts.certbotRc ?? 0)], {
    input: answers,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { rc: res.status ?? -1, out: (res.stdout ?? '') + (res.stderr ?? '') };
}

function fileState(sandbox: string): Record<string, string> {
  const state: Record<string, string> = {};
  for (const rel of TRACKED) {
    try {
      state[rel] = createHash('md5').update(readFileSync(join(sandbox, rel))).digest('hex');
    } catch {
      state[rel] = 'MISSING';
    }
  }
  return state;
}

function content(sandbox: string, rel: string): string {
  return readFileSync(join(sandbox, rel), 'utf8');
}

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

// Each scenario runs install.sh synchronously (spawnSync, up to 60s) — vitest 3
// enforces the test timeout on synchronous tests too, so give them room.
describe('install.sh — V4-003 safe activation', { timeout: 120_000 }, () => {
  it('scenario 1: first run (stack stopped, certbot OK) activates everything', () => {
    const sandbox = makeSandbox();
    sandboxes.push(sandbox);

    const { rc, out } = runInstallerPosix(sandbox, 'first.example.com');
    expect(rc, out).toBe(0);
    expect(content(sandbox, '.env.prod')).toContain('NEXT_PUBLIC_BASE_URL=https://first.example.com');
    expect(content(sandbox, 'infra/nginx/conf.d/app.conf')).toContain('server_name first.example.com;');
    // VOICE-001: livekit.yaml no longer carries static turn_servers —
    // the domain proof here is the rendered TURN secret wiring instead.
    expect(content(sandbox, 'infra/livekit/livekit.yaml')).not.toContain('turn_servers:');
    expect(content(sandbox, 'infra/turn/turnserver.conf')).toContain('use-auth-secret');
    expect(content(sandbox, 'infra/turn/turnserver.conf')).toContain('realm=first.example.com');
  });

  it('scenario 2: RUNNING stack + SAME domain → action menu; exit changes NOTHING', () => {
    const sandbox = makeSandbox();
    sandboxes.push(sandbox);
    expect(runInstallerPosix(sandbox, 'same.example.com').rc).toBe(0);
    const before = fileState(sandbox);

    // OPS-003 + 22nd-audit: the installer offers update-guidance/renew/exit;
    // answer exit. Updates are NOT performed by the installer (bypassed the
    // signed-manifest updater) — option 1 only prints the lfctl commands.
    const { rc, out } = runInstallerPosix(sandbox, 'same.example.com', { stackRunning: true }, '3\n');
    expect(rc, out).toBe(0);
    expect(out).toContain('How to update');
    expect(out).toContain('Renew TLS certificates only');
    expect(out).toContain('No changes made');
    expect(fileState(sandbox)).toEqual(before); // byte-for-byte untouched
  });

  it('scenario 2b: menu option 1 prints the signed-release updater commands and changes NOTHING', () => {
    const sandbox = makeSandbox();
    sandboxes.push(sandbox);
    expect(runInstallerPosix(sandbox, 'same.example.com').rc).toBe(0);
    const before = fileState(sandbox);

    // The shared harness appends its trailing "Y" AFTER extraInput, so the
    // menu would swallow the Y — drive this scenario with exact stdin:
    // domain, community name, official=n, then menu choice 1.
    const res = spawnSync(
      'bash',
      ['-c', `cd "$1" && PATH="$2:$PATH" FAKE_DOCKER_PS="lobbyforge-nginx" bash ./install.sh`, 'run', sandbox, join(sandbox, 'bin')],
      { input: 'same.example.com\nE2E Community\nn\n1\n', encoding: 'utf8', timeout: 60_000 }
    );
    const rc = res.status ?? -1;
    const out = (res.stdout ?? '') + (res.stderr ?? '');
    expect(rc, out).toBe(0);
    expect(out).toContain('lfctl.mjs update check');
    expect(out).toContain('lfctl.mjs update apply --yes');
    expect(out).toContain('No changes were made');
    expect(fileState(sandbox)).toEqual(before); // the installer never rebuilds a live stack
  });

  it('scenario 6: bring-your-own certificate (Cloudflare Origin CA path) — PEM installed, activation proceeds', () => {
    const sandbox = makeSandbox();
    sandboxes.push(sandbox);
    const certDir = join(sandbox, 'certs');
    mkdirSync(certDir);
    execSync(
      'openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj "/CN=own.example.com"',
      { cwd: certDir, stdio: 'pipe' }
    );
    const cert = join(certDir, 'cert.pem').replace(/\\/g, '/');
    const key = join(certDir, 'key.pem').replace(/\\/g, '/');

    // domain, community, official=n, certbot=n, own-cert=y, cert, key
    const res = spawnSync(
      'bash',
      ['-c', `cd "$1" && PATH="$2:$PATH" bash ./install.sh`, 'run', sandbox, join(sandbox, 'bin')],
      { input: `own.example.com\nE2E Community\nn\nn\ny\n${cert}\n${key}\n`, encoding: 'utf8', timeout: 60_000 }
    );
    const rc = res.status ?? -1;
    const out = (res.stdout ?? '') + (res.stderr ?? '');
    expect(rc, out).toBe(0);
    expect(out).toContain('Certificate installed at');
    // Installed at the exact path nginx expects.
    const fullchain = readFileSync(
      join(sandbox, 'infra', 'certbot', 'conf', 'live', 'own.example.com', 'fullchain.pem'),
      'utf8'
    );
    expect(fullchain).toContain('BEGIN CERTIFICATE');
    expect(content(sandbox, '.env.prod')).toContain('NEXT_PUBLIC_BASE_URL=https://own.example.com');
  });

  it('scenario 6b: own certificate that does NOT match the key → abort, nothing activated', () => {
    const sandbox = makeSandbox();
    sandboxes.push(sandbox);
    const certDir = join(sandbox, 'certs');
    mkdirSync(certDir);
    // Two INDEPENDENT pairs — passing cert from pair A with key from pair B
    // must be rejected by the public-key match check.
    for (const name of ['a', 'b']) {
      execSync(
        `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${name}-key.pem -out ${name}-cert.pem -days 2 -subj "/CN=own.example.com"`,
        { cwd: certDir, stdio: 'pipe' }
      );
    }
    const cert = join(certDir, 'a-cert.pem').replace(/\\/g, '/');
    const wrongKey = join(certDir, 'b-key.pem').replace(/\\/g, '/');

    const res = spawnSync(
      'bash',
      ['-c', `cd "$1" && PATH="$2:$PATH" bash ./install.sh`, 'run', sandbox, join(sandbox, 'bin')],
      { input: `own.example.com\nE2E Community\nn\nn\ny\n${cert}\n${wrongKey}\n`, encoding: 'utf8', timeout: 60_000 }
    );
    const rc = res.status ?? -1;
    const out = (res.stdout ?? '') + (res.stderr ?? '');
    expect(rc, out).toBe(1);
    expect(out).toContain('does not match the private key');
    // Nothing activated — the fail-closed P0-D path.
    expect(existsSync(join(sandbox, '.env.prod'))).toBe(false);
  });

  it('scenario 3: RUNNING stack + DIFFERENT domain → early exit, NOTHING modified', () => {
    const sandbox = makeSandbox();
    sandboxes.push(sandbox);
    expect(runInstallerPosix(sandbox, 'old.example.com').rc).toBe(0);
    const before = fileState(sandbox);

    const { rc, out } = runInstallerPosix(sandbox, 'new.example.com', { stackRunning: true });
    expect(rc, out).toBe(1);
    expect(out).toContain('down');
    expect(fileState(sandbox)).toEqual(before); // the audit's core demand
  });

  it('scenario 4: stopped stack + DIFFERENT domain + certbot FAILS → old files survive', () => {
    const sandbox = makeSandbox();
    sandboxes.push(sandbox);
    expect(runInstallerPosix(sandbox, 'old.example.com').rc).toBe(0);
    const before = fileState(sandbox);

    const { rc, out } = runInstallerPosix(sandbox, 'new.example.com', { certbotRc: 1 });
    expect(rc, out).toBe(1);
    expect(out).toContain('NOT modified');
    expect(fileState(sandbox)).toEqual(before);
  });

  it('scenario 5: stopped stack + DIFFERENT domain + certbot OK → everything switches', () => {
    const sandbox = makeSandbox();
    sandboxes.push(sandbox);
    expect(runInstallerPosix(sandbox, 'old.example.com').rc).toBe(0);

    const { rc, out } = runInstallerPosix(sandbox, 'new.example.com');
    expect(rc, out).toBe(0);
    expect(content(sandbox, '.env.prod')).toContain('https://new.example.com');
    expect(content(sandbox, 'infra/nginx/conf.d/app.conf')).toContain('server_name new.example.com;');
    expect(content(sandbox, 'infra/livekit/livekit.yaml')).not.toContain('turn_servers:');
    expect(content(sandbox, 'infra/turn/turnserver.conf')).toContain('realm=new.example.com');
    // Staging must not leak into the live tree.
    expect(out).not.toContain('.install-staging');
  });

  it('scenario 5b: same re-run reuses secrets from the existing .env.prod', () => {
    const sandbox = makeSandbox();
    sandboxes.push(sandbox);
    expect(runInstallerPosix(sandbox, 'keep.example.com').rc).toBe(0);
    const firstEnv = content(sandbox, '.env.prod');
    const adminToken = /^LOBBYFORGE_ADMIN_TOKEN=(.+)$/m.exec(firstEnv)![1]!;

    const { rc } = runInstallerPosix(sandbox, 'keep.example.com', { certbotRc: 1 });
    expect(rc).toBe(1); // cert failed → activation skipped, old env still live
    expect(content(sandbox, '.env.prod')).toBe(firstEnv);
    expect(adminToken).toMatch(/^[0-9a-f]{64}$/);
  });
});
