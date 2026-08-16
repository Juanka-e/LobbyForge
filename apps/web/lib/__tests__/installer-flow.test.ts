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
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
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

/** Git Bash uses ':' separators; convert the ';' we injected. */
function runInstallerPosix(sandbox: string, domain: string, opts: Parameters<typeof runInstaller>[2] = {}) {
  const answers = `${domain}\nE2E Community\nn\nY\n`;
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

describe('install.sh — V4-003 safe activation', () => {
  it('scenario 1: first run (stack stopped, certbot OK) activates everything', () => {
    const sandbox = makeSandbox();
    sandboxes.push(sandbox);

    const { rc, out } = runInstallerPosix(sandbox, 'first.example.com');
    expect(rc, out).toBe(0);
    expect(content(sandbox, '.env.prod')).toContain('NEXT_PUBLIC_BASE_URL=https://first.example.com');
    expect(content(sandbox, 'infra/nginx/conf.d/app.conf')).toContain('server_name first.example.com;');
    expect(content(sandbox, 'infra/livekit/livekit.yaml')).toContain('host: first.example.com');
    expect(content(sandbox, 'infra/turn/turnserver.conf')).toContain('realm=first.example.com');
  });

  it('scenario 2: RUNNING stack + SAME domain → renew hint, NOTHING modified', () => {
    const sandbox = makeSandbox();
    sandboxes.push(sandbox);
    expect(runInstallerPosix(sandbox, 'same.example.com').rc).toBe(0);
    const before = fileState(sandbox);

    const { rc, out } = runInstallerPosix(sandbox, 'same.example.com', { stackRunning: true });
    expect(rc, out).toBe(0);
    expect(out).toContain('renew');
    expect(fileState(sandbox)).toEqual(before); // byte-for-byte untouched
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
    expect(content(sandbox, 'infra/livekit/livekit.yaml')).toContain('host: new.example.com');
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
