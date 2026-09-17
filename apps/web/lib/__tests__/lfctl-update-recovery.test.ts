/**
 * 23rd-audit regression spec — the REAL lfctl CLI rollout sequencing,
 * driven end-to-end with a fake `docker` binary (same technique as
 * installer-flow.test.ts).
 *
 * Covers the exact scenario the 22nd-audit recovery fix targeted and the
 * 23rd-audit flag-timing bug almost broke:
 *
 *   compose up -d --remove-orphans --wait
 *     → creates the NEW containers
 *     → healthcheck fails
 *     → exits non-zero                       ← recovery MUST trigger here
 *     → catch restores .env.prod, re-runs `up` on the old ref, health-checks
 *
 * The fake docker records every invocation; `up` returns per-invocation
 * exit codes from FAKE_UP_RCS so partial-failure sequences are scripted.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

const FAKE_DOCKER = `#!/bin/sh
# Records every invocation; 'up -d --remove-orphans --wait' returns the
# Nth exit code from FAKE_UP_RCS (comma separated, default 0).
# 'ps -q <svc>' reports the service's container (FAKE_WEB_CONTAINER;
# empty = not running — ws-gateway may differ via FAKE_WS_CONTAINER).
# 'inspect <cid>' reports the container's image (the ws-gateway
# container can carry a DIFFERENT image via FAKE_WS_IMAGE_ID); 'image
# inspect <ref>' reports the configured ref's local ID
# (FAKE_CONFIGURED_IMAGE_ID) — the drift scenarios make these disagree.
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case " $* " in
  *" tag "*) exit 0 ;;
  *" ps -q web "*)
    [ -n "$FAKE_WEB_CONTAINER" ] && echo "$FAKE_WEB_CONTAINER"
    exit 0
    ;;
  *" ps -q ws-gateway "*)
    echo "\${FAKE_WS_CONTAINER:-\$FAKE_WEB_CONTAINER}"
    exit 0
    ;;
  *" ps -q plugin-worker "*)
    echo "$FAKE_WEB_CONTAINER"
    exit 0
    ;;
  *" image inspect "*)
    echo "$FAKE_CONFIGURED_IMAGE_ID"
    exit 0
    ;;
  *" inspect "*)
    if [ -n "$FAKE_WS_IMAGE_ID" ] && [ "$2" = "$FAKE_WS_CONTAINER" ]; then
      echo "$FAKE_WS_IMAGE_ID"
    else
      echo "$FAKE_IMAGE_ID"
    fi
    exit 0
    ;;
  *" up -d --remove-orphans --wait "*)
    n=$(grep -c "up -d --remove-orphans --wait" "$FAKE_DOCKER_LOG" 2>/dev/null || true)
    rc=$(printf '%s' "$FAKE_UP_RCS" | cut -d, -f"$n")
    [ -n "$rc" ] || rc=0
    exit "$rc"
    ;;
esac
exit 0
`;

const RUNNING_IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const CONFIGURED_DIGEST_REF = `ghcr.io/juanka-e/lobbyforge@sha256:${'d'.repeat(64)}`;

interface Sandbox {
  dir: string;
  dockerLog: string;
  fakeDocker: string;
}

const sandboxes: Sandbox[] = [];

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'lf-upd-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const dockerLog = join(dir, 'docker-calls.log');
  // Node's execFile cannot run a POSIX script on Windows — lfctl's
  // LFCTL_DOCKER override lets the tests launch the fake through bash on
  // every platform ("bash <path>").
  const fakeDocker = join(dir, 'bin', 'docker-fake');
  writeFileSync(fakeDocker, FAKE_DOCKER.replace(/\r\n/g, '\n'), { mode: 0o755 });
  chmodSync(fakeDocker, 0o755);

  // Fresh-install-like env: locally built mutable image at 0.2.0.
  writeFileSync(
    join(dir, '.env.prod'),
    'LOBBYFORGE_VERSION=0.2.0\nLOBBYFORGE_IMAGE=lobbyforge-web:latest\nNODE_ENV=production\n'
  );

  // Backup: a real dump + its strict-verification manifest.
  const dump = Buffer.from('pg-dump-custom-format-payload-0123456789');
  writeFileSync(join(dir, 'backup.dump'), dump);
  writeFileSync(
    join(dir, 'backup.manifest.json'),
    JSON.stringify(
      {
        formatVersion: 1,
        backupId: 'backup-test',
        completed: true,
        createdAt: new Date().toISOString(),
        databaseDump: {
          path: 'backup.dump',
          sha256: createHash('sha256').update(dump).digest('hex'),
          sizeBytes: dump.length,
        },
        includes: { database: true },
      },
      null,
      2
    )
  );

  // Signed release manifest pinning an immutable digest (major bump —
  // the runner gets --force-major).
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(dir, 'release-public.pem'), publicKey.export({ format: 'pem', type: 'spki' }));
  const manifest: Record<string, unknown> = {
    version: '9.9.9',
    channel: 'stable',
    gitSha: 'a'.repeat(40),
    imageDigest: `ghcr.io/juanka-e/lobbyforge@sha256:${'b'.repeat(64)}`,
  };
  manifest.signature = sign(
    null,
    Buffer.from(canonicalize(manifest), 'utf8'),
    privateKey
  ).toString('base64url');
  writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify(manifest, null, 2));

  const sandbox = { dir, dockerLog, fakeDocker };
  sandboxes.push(sandbox);
  return sandbox;
}

function runApply(
  sandbox: Sandbox,
  upRcs: string,
  opts: {
    webContainer?: string;
    configuredImageId?: string;
    wsContainer?: string;
    wsImageId?: string;
  } = {}
) {
  const fakeViaBash = `bash ${sandbox.fakeDocker.replace(/\\/g, '/')}`;
  const res = spawnSync(
    'bash',
    [
      '-c',
      `cd "$1" && FAKE_DOCKER_LOG="$2" FAKE_UP_RCS="$3" LFCTL_DOCKER="$4" FAKE_WEB_CONTAINER="$5" \
         FAKE_IMAGE_ID="$6" FAKE_CONFIGURED_IMAGE_ID="$7" FAKE_WS_CONTAINER="$8" FAKE_WS_IMAGE_ID="$9" node "\${10}" update apply \
        --manifest release-manifest.json --backup-manifest backup.manifest.json \
        --public-key release-public.pem --yes --force-major`,
      'run',
      sandbox.dir,
      sandbox.dockerLog,
      upRcs,
      fakeViaBash,
      opts.webContainer ?? 'fake-web-container',
      RUNNING_IMAGE_ID,
      opts.configuredImageId ?? RUNNING_IMAGE_ID,
      opts.wsContainer ?? '',
      opts.wsImageId ?? '',
      LFCTL,
    ],
    { encoding: 'utf8', timeout: 60_000 }
  );
  return { rc: res.status ?? -1, out: (res.stdout ?? '') + (res.stderr ?? '') };
}

function dockerCalls(sandbox: Sandbox): string[] {
  try {
    return readFileSync(sandbox.dockerLog, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function envValue(sandbox: Sandbox, key: string): string | null {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(join(sandbox.dir, '.env.prod'), 'utf8'));
  return m ? m[1].trim() : null;
}

function state(sandbox: Sandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sandbox.dir, 'infra', 'update', 'deployment-state.json'), 'utf8'));
}

function upCount(sandbox: Sandbox): number {
  return dockerCalls(sandbox).filter((c) => c.includes('up -d --remove-orphans --wait')).length;
}

describe('lfctl update apply — rollout failure recovery (23rd-audit)', () => {
  it('healthy rollout: up once, digest deployed, version state persisted', () => {
    const sandbox = makeSandbox();
    const { rc, out } = runApply(sandbox, ''); // all ups succeed
    expect(rc, out).toBe(0);
    expect(out).toContain('Update completed successfully');
    expect(upCount(sandbox)).toBe(1);
    expect(envValue(sandbox, 'LOBBYFORGE_IMAGE')).toBe(`ghcr.io/juanka-e/lobbyforge@sha256:${'b'.repeat(64)}`);
    expect(envValue(sandbox, 'LOBBYFORGE_VERSION')).toBe('9.9.9');
    // A byte-exact rollback anchor was pinned and recorded as previous.
    expect(envValue(sandbox, 'LOBBYFORGE_IMAGE')).not.toContain(':latest');
    const st = state(sandbox);
    expect(st.version).toBe('9.9.9');
    expect((st.previous as Record<string, unknown>).version).toBe('0.2.0');
    expect(String((st.previous as Record<string, unknown>).image)).toMatch(/^lobbyforge-web:rollback-\d+$/);
  });

  it('compose up creates new containers then FAILS: old containers restored + healthy', () => {
    const sandbox = makeSandbox();
    const { rc, out } = runApply(sandbox, '1,0'); // 1st up fails, recovery up succeeds
    expect(rc, out).toBe(2);
    // THE regression: recovery must trigger even though `up` exited non-zero.
    expect(out).toContain('OLD CONTAINERS RESTORED AND HEALTHY');
    expect(upCount(sandbox)).toBe(2);
    // .env.prod points back at the byte-exact rollback anchor.
    expect(envValue(sandbox, 'LOBBYFORGE_IMAGE')).toMatch(/^lobbyforge-web:rollback-\d+$/);
    expect(envValue(sandbox, 'LOBBYFORGE_VERSION')).toBe('0.2.0');
    const st = state(sandbox);
    expect(st.version).toBe('0.2.0');
    expect(st.previous).toBeNull(); // auto-recovery consumed the pointer
    expect(String(st.note)).toContain('RESTORED');
  });

  it('recovery up also fails: previous pointer KEPT so update rollback works', () => {
    const sandbox = makeSandbox();
    const { rc, out } = runApply(sandbox, '1,1'); // both ups fail
    expect(rc, out).toBe(2);
    expect(out).toContain('MANUAL ROLLBACK REQUIRED');
    expect(upCount(sandbox)).toBe(2);
    expect(out).toContain('lfctl.mjs update rollback');
    const st = state(sandbox);
    const previous = st.previous as Record<string, unknown>;
    expect(previous).not.toBeNull();
    expect(previous.version).toBe('0.2.0');
    expect(String(previous.image)).toMatch(/^lobbyforge-web:rollback-\d+$/);
    expect(envValue(sandbox, 'LOBBYFORGE_IMAGE')).toMatch(/^lobbyforge-web:rollback-\d+$/);
  });

  it('no running web container: abort BEFORE touching anything (anchor fail-closed)', () => {
    const sandbox = makeSandbox();
    // 24th-audit: the anchor pins the RUNNING container's image ID — when
    // no container is running there is nothing byte-exact to pin, and the
    // update must abort before mutating env or state.
    const { rc, out } = runApply(sandbox, '', { webContainer: '' });
    expect(rc, out).toBe(2);
    expect(out).toContain('no running web container');
    expect(upCount(sandbox)).toBe(0);
    expect(envValue(sandbox, 'LOBBYFORGE_IMAGE')).toBe('lobbyforge-web:latest'); // untouched
    expect(envValue(sandbox, 'LOBBYFORGE_VERSION')).toBe('0.2.0');
  });

  it('digest-configured deployment: running bytes verified, digest kept as rollback target', () => {
    const sandbox = makeSandbox();
    // A server already updated once by lfctl: .env.prod pins a digest.
    writeFileSync(
      join(sandbox.dir, '.env.prod'),
      `LOBBYFORGE_VERSION=9.9.8\nLOBBYFORGE_IMAGE=${CONFIGURED_DIGEST_REF}\nNODE_ENV=production\n`
    );
    const { rc, out } = runApply(sandbox, ''); // configured resolves to the running image
    expect(rc, out).toBe(0);
    expect(out).toContain('Configured digest matches the running container');
    // No rollback anchor tag needed — the digest IS byte-exact.
    expect(dockerCalls(sandbox).some((c) => c.startsWith('tag '))).toBe(false);
    const st = state(sandbox);
    expect(st.previous).toEqual({ version: '9.9.8', image: CONFIGURED_DIGEST_REF });
  });

  it('operator drift (configured digest != running bytes): abort BEFORE touching anything', () => {
    const sandbox = makeSandbox();
    writeFileSync(
      join(sandbox.dir, '.env.prod'),
      `LOBBYFORGE_VERSION=9.9.8\nLOBBYFORGE_IMAGE=${CONFIGURED_DIGEST_REF}\nNODE_ENV=production\n`
    );
    // .env.prod's digest resolves to DIFFERENT bytes than the running
    // container — someone changed the deployment outside lfctl.
    const { rc, out } = runApply(sandbox, '', { configuredImageId: `sha256:${'e'.repeat(64)}` });
    expect(rc, out).toBe(2);
    expect(out).toContain('Deployed-image drift');
    expect(upCount(sandbox)).toBe(0);
    expect(envValue(sandbox, 'LOBBYFORGE_IMAGE')).toBe(CONFIGURED_DIGEST_REF); // untouched
    expect(envValue(sandbox, 'LOBBYFORGE_VERSION')).toBe('9.9.8');
  });

  it('mixed fleet (ws-gateway hand-edited to another image): abort BEFORE touching anything', () => {
    const sandbox = makeSandbox();
    // 26th-audit: web/plugin-worker match each other, but ws-gateway was
    // hand-pointed at a different image — a web-only check would miss it.
    const { rc, out } = runApply(sandbox, '', {
      wsContainer: 'fake-ws-container',
      wsImageId: `sha256:${'f'.repeat(64)}`,
    });
    expect(rc, out).toBe(2);
    expect(out).toContain('ws-gateway runs');
    expect(out).toContain('while web runs');
    expect(upCount(sandbox)).toBe(0);
    expect(envValue(sandbox, 'LOBBYFORGE_IMAGE')).toBe('lobbyforge-web:latest'); // untouched
  });
});
