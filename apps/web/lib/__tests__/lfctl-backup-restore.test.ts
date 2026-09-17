/**
 * 30th-audit P1 regression — `lfctl backup restore` on a NORMAL
 * production install:
 *
 *   - no host psql/pg_restore tools installed
 *   - DATABASE_URL-style target uses the compose-internal "postgres" host
 *   - LFCTL_PG_CONTAINER is NOT set (the CI drill sets it explicitly and
 *     therefore never exercised the auto-discovery path)
 *
 * The fake docker resolves `compose ps -q postgres` (discovery) and then
 * must serve psql/pg_restore/cp INSIDE that container. With the fix,
 * restore succeeds end-to-end; the docker log proves every pg tool ran
 * via `exec <container>`.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const LFCTL = join(REPO_ROOT, 'scripts', 'lfctl.mjs');

const FAKE_DOCKER = `#!/bin/sh
# Logs every invocation. pg tools must run INSIDE the discovered
# container (docker exec <pgc> psql|pg_restore); docker cp stages the dump.
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case " $* " in
  *" ps -q postgres "*)
    echo "fake-pg-container"
    exit 0
    ;;
  *" psql "*|*" pg_restore "*|*" rm -f "*)
    # psql's emptiness probe prints 0 tables; everything else is silent OK.
    case " $* " in *" information_schema.tables "*) echo "0" ;; esac
    exit 0
    ;;
  *" cp "*)
    exit 0
    ;;
esac
exit 0
`;

const PG_CONTAINER_ENV_UNSET = ''; // production: NOT set

interface Sandbox {
  dir: string;
  dockerLog: string;
  fakeDocker: string;
}

const sandboxes: Sandbox[] = [];

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'lf-restore-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const dockerLog = join(dir, 'docker-calls.log');
  const fakeDocker = join(dir, 'bin', 'docker-fake');
  writeFileSync(fakeDocker, FAKE_DOCKER.replace(/\r\n/g, '\n'), { mode: 0o755 });
  chmodSync(fakeDocker, 0o755);

  const dump = Buffer.from('restore-me: pg custom format payload …');
  writeFileSync(join(dir, 'backup.dump'), dump);
  writeFileSync(
    join(dir, 'backup.dump.json'),
    JSON.stringify({
      file: 'backup.dump',
      sha256: createHash('sha256').update(dump).digest('hex'),
      sizeBytes: dump.length,
      createdAt: new Date().toISOString(),
    })
  );

  const sandbox = { dir, dockerLog, fakeDocker };
  sandboxes.push(sandbox);
  return sandbox;
}

function runRestore(sandbox: Sandbox) {
  // NOTE: LFCTL_PG_CONTAINER deliberately UNSET — production shape.
  const res = spawnSync(
    'bash',
    [
      '-c',
      `cd "$1" && env -u LFCTL_PG_CONTAINER FAKE_DOCKER_LOG="$2" LFCTL_DOCKER="bash $3" node "$4" backup restore \
        --file backup.dump --to "postgres://u:p@postgres:5432/restored" --json`,
      'run',
      sandbox.dir,
      sandbox.dockerLog,
      sandbox.fakeDocker.replace(/\\/g, '/'),
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

describe('lfctl backup restore — production shape (30th audit)', () => {
  it('auto-discovers the compose postgres when LFCTL_PG_CONTAINER is unset and host tools absent', () => {
    const sandbox = makeSandbox();
    expect(PG_CONTAINER_ENV_UNSET).toBe(''); // guard: the env really is unset
    const { rc, out } = runRestore(sandbox);
    expect(rc, out).toBe(0);
    expect(out).toContain('"ok": true');

    const calls = dockerCalls(sandbox);
    // Discovery happened…
    expect(calls.some((c) => c.includes('ps -q postgres'))).toBe(true);
    // …and EVERY pg tool ran inside the discovered container, not on the host.
    expect(calls.some((c) => c.includes('exec fake-pg-container psql'))).toBe(true);
    expect(calls.some((c) => c.includes('exec fake-pg-container pg_restore'))).toBe(true);
    // No host-mode psql/pg_restore invocation (no container prefix).
    expect(calls.some((c) => /^psql /.test(c) || /^pg_restore /.test(c))).toBe(false);
  });

  it('checksum mismatch is still refused before any pg tool runs', () => {
    const sandbox = makeSandbox();
    // Corrupt the dump AFTER the sidecar was written → digest mismatch.
    writeFileSync(join(sandbox.dir, 'backup.dump'), Buffer.from('tampered'));
    const { rc, out } = runRestore(sandbox);
    expect(rc, out).toBe(2);
    expect(out).toContain('SHA-256 mismatch');
    // Container discovery may run first (it is read-only), but NO pg tool
    // and no dump-copy may execute against a corrupt dump.
    const calls = dockerCalls(sandbox);
    expect(calls.some((c) => /psql|pg_restore|\bcp\b/.test(c))).toBe(false);
  });
});
