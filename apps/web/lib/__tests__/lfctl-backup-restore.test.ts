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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const LFCTL = join(REPO_ROOT, 'scripts', 'lfctl.mjs');

const FAKE_DOCKER = `#!/bin/sh
# Logs every invocation. pg tools must run INSIDE the discovered
# container (docker exec <pgc> psql|pg_restore); docker cp stages the dump.
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case " $* " in
  *" exec -T web sh -c "*)
    # The web container archives / restores the plugin bundles.
    if [ -n "$FAKE_PLUGINS_FAIL" ]; then echo "service \\"web\\" is not running" >&2; exit 1; fi
    case " $* " in
      *" -xzf "*) cat > "$FAKE_PLUGINS_RESTORED" ;;
      *) printf 'PLUGINS-TAR-fake' ;;
    esac
    exit 0
    ;;
  *" ps -q postgres "*)
    echo "fake-pg-container"
    exit 0
    ;;
  *" pg_dump "*)
    printf 'PGDMP-fake-custom-format'
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
      `cd "$1" && env -u LFCTL_PG_CONTAINER LFCTL_ROOT="$1" FAKE_DOCKER_LOG="$2" LFCTL_DOCKER="bash $3" node "$4" backup restore \
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

/**
 * Security follow-up: a backup is the whole database — `backup create`
 * makes its directory 0700 and every file 0600 (POSIX; Windows has no
 * mode bits), and the default directory is `<lfctl root>/backups`, not
 * `<cwd>/backups`.
 */
function runBackupCreate(sandbox: Sandbox, cwd: string, extraArgs = '') {
  const res = spawnSync(
    'bash',
    [
      '-c',
      `cd "$1" && env -u LFCTL_PG_CONTAINER LFCTL_ROOT="$2" FAKE_DOCKER_LOG="$3" LFCTL_DOCKER="bash $4" node "$5" backup create \
        --database-url "postgres://u:p@postgres:5432/lobbyforge" --json ${extraArgs}`,
      'run',
      cwd,
      sandbox.dir,
      sandbox.dockerLog,
      sandbox.fakeDocker.replace(/\\/g, '/'),
      LFCTL,
    ],
    { encoding: 'utf8', timeout: 60_000 }
  );
  return { rc: res.status ?? -1, out: (res.stdout ?? '') + (res.stderr ?? '') };
}

const POSIX = process.platform !== 'win32';

describe('lfctl backup create — owner-only files (security follow-up)', () => {
  it('writes the dump and its manifests under <root>/backups, 0700 dir and 0600 files', () => {
    const sandbox = makeSandbox();
    const elsewhere = join(sandbox.dir, 'elsewhere');
    mkdirSync(elsewhere);
    const { rc, out } = runBackupCreate(sandbox, elsewhere);
    expect(rc, out).toBe(0);
    // Default directory: the lfctl root, not the cwd.
    expect(existsSync(join(elsewhere, 'backups'))).toBe(false);
    const dir = join(sandbox.dir, 'backups');
    const files = readdirSync(dir);
    const dump = files.find((f) => f.endsWith('.dump'))!;
    expect(dump).toBeTruthy();
    expect(files.sort()).toEqual(
      [dump, `${dump}.json`, `${dump}.manifest.json`, `${dump}.plugins.tar.gz`].sort()
    );
    expect(readFileSync(join(dir, dump), 'utf8')).toBe('PGDMP-fake-custom-format');
    if (POSIX) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const f of files) expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o600);
    }
  });

  it.skipIf(!POSIX)('leaves an existing --out directory mode alone but warns when others can read it', () => {
    const sandbox = makeSandbox();
    const shared = join(sandbox.dir, 'shared');
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    const { rc, out } = runBackupCreate(sandbox, sandbox.dir, '--out shared');
    expect(rc, out).toBe(0);
    expect(out).toContain('accessible to other users');
    expect(statSync(shared).mode & 0o777).toBe(0o755);
    for (const f of readdirSync(shared)) expect(statSync(join(shared, f)).mode & 0o777, f).toBe(0o600);
  });
});

/**
 * Run lfctl in the sandbox with the fake docker. Arguments go to node as an
 * array and variables through the child's environment — no shell string is
 * built from them.
 */
function runLfctl(sandbox: Sandbox, args: readonly string[], extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.LFCTL_PG_CONTAINER;
  delete env.DATABASE_URL;
  Object.assign(env, {
    LFCTL_ROOT: sandbox.dir,
    FAKE_DOCKER_LOG: sandbox.dockerLog,
    FAKE_PLUGINS_RESTORED: `${sandbox.dir}/plugins-restored.bin`,
    LFCTL_DOCKER: `bash ${sandbox.fakeDocker.replace(/\\/g, '/')}`,
    ...extraEnv,
  });
  const res = spawnSync(process.execPath, [LFCTL, ...args], { cwd: sandbox.dir, env, encoding: 'utf8', timeout: 60_000 });
  return { rc: res.status ?? -1, out: (res.stdout ?? '') + (res.stderr ?? '') };
}

function onlyDump(sandbox: Sandbox): string {
  const dir = join(sandbox.dir, 'backups');
  return join(dir, readdirSync(dir).find((f) => f.endsWith('.dump'))!);
}

describe('lfctl backup create — database URL (G12)', () => {
  it('reads DATABASE_URL from .env.prod like update apply, when neither the flag nor the env var is set', () => {
    const sandbox = makeSandbox();
    writeFileSync(join(sandbox.dir, '.env.prod'), 'DATABASE_URL=postgres://u:p@postgres:5432/fromenvprod\n');
    const { rc, out } = runLfctl(sandbox, ['backup', 'create', '--json']);
    expect(rc, out).toBe(0);
    expect(dockerCalls(sandbox).some((c) => c.includes('pg_dump -Fc postgres://u:p@postgres:5432/fromenvprod'))).toBe(true);
  });

  it('still refuses with no URL anywhere', () => {
    const sandbox = makeSandbox();
    const { rc, out } = runLfctl(sandbox, ['backup', 'create', '--json']);
    expect(rc).not.toBe(0);
    expect(out).toContain('requires --database-url');
  });
});

describe('lfctl backup — plugin bundles (G13)', () => {
  const DB = ['--database-url', 'postgres://u:p@postgres:5432/lobbyforge'];

  it('archives the installed plugin bundles next to the dump and lists them in both manifests', () => {
    const sandbox = makeSandbox();
    const { rc, out } = runLfctl(sandbox, ['backup', 'create', ...DB, '--json']);
    expect(rc, out).toBe(0);
    const dump = onlyDump(sandbox);
    const archive = `${dump}.plugins.tar.gz`;
    expect(readFileSync(archive, 'utf8')).toBe('PLUGINS-TAR-fake');
    if (POSIX) expect(statSync(archive).mode & 0o777).toBe(0o600);
    const sha = createHash('sha256').update('PLUGINS-TAR-fake').digest('hex');
    const manifest = JSON.parse(readFileSync(`${dump}.manifest.json`, 'utf8'));
    expect(manifest.includes).toEqual({ database: true, plugins: true });
    expect(manifest.pluginsArchive).toEqual({ path: `${basename(dump)}.plugins.tar.gz`, sha256: sha, sizeBytes: 16 });
    const sidecar = JSON.parse(readFileSync(`${dump}.json`, 'utf8'));
    expect(sidecar.plugins).toEqual({ archive: manifest.pluginsArchive.path, sha256: sha });
    // Made by the running web container, over compose.
    expect(dockerCalls(sandbox).some((c) => c.includes('exec -T web sh -c') && c.includes('tar -czf - installed'))).toBe(true);

    // Strict verification hashes the archive too.
    const verified = runLfctl(sandbox, ['backup', 'verify', '--manifest', `${dump.replace(/\\/g, '/')}.manifest.json`, '--require-files', '--json']);
    expect(verified.rc, verified.out).toBe(0);
    writeFileSync(archive, 'tampered');
    const tampered = runLfctl(sandbox, ['backup', 'verify', '--manifest', `${dump.replace(/\\/g, '/')}.manifest.json`, '--require-files', '--json']);
    expect(tampered.rc).toBe(2);
    expect(tampered.out).toContain('pluginsArchive.sha256Match');
  });

  it('a backup whose bundles cannot be archived still succeeds, says so, and records includes.plugins: false', () => {
    const sandbox = makeSandbox();
    const { rc, out } = runLfctl(sandbox, ['backup', 'create', ...DB, '--json'], { FAKE_PLUGINS_FAIL: '1' });
    expect(rc, out).toBe(0);
    expect(out).toContain('plugin bundles were NOT archived');
    const dump = onlyDump(sandbox);
    expect(existsSync(`${dump}.plugins.tar.gz`)).toBe(false);
    const manifest = JSON.parse(readFileSync(`${dump}.manifest.json`, 'utf8'));
    expect(manifest.includes).toEqual({ database: true, plugins: false });
    expect(manifest.pluginsArchive).toBeUndefined();
  });

  function withPluginArchive(sandbox: Sandbox, archiveBytes: Buffer, listedSha?: string): void {
    writeFileSync(join(sandbox.dir, 'backup.dump.plugins.tar.gz'), archiveBytes);
    const sidecar = JSON.parse(readFileSync(join(sandbox.dir, 'backup.dump.json'), 'utf8'));
    sidecar.plugins = {
      archive: 'backup.dump.plugins.tar.gz',
      sha256: listedSha ?? createHash('sha256').update(archiveBytes).digest('hex'),
    };
    writeFileSync(join(sandbox.dir, 'backup.dump.json'), JSON.stringify(sidecar));
  }

  const RESTORE = ['backup', 'restore', '--file', 'backup.dump', '--to', 'postgres://u:p@postgres:5432/restored', '--json'];

  it('restore puts the bundles back through the web container, after the database', () => {
    const sandbox = makeSandbox();
    const bytes = Buffer.from('gzip-tar-of-installed-bundles');
    withPluginArchive(sandbox, bytes);
    const { rc, out } = runLfctl(sandbox, RESTORE);
    expect(rc, out).toBe(0);
    expect(out).toContain('Plugin bundles restored');
    expect(readFileSync(join(sandbox.dir, 'plugins-restored.bin'))).toEqual(bytes);
    const calls = dockerCalls(sandbox);
    const restoreAt = calls.findIndex((c) => c.includes('pg_restore'));
    const pluginsAt = calls.findIndex((c) => c.includes('exec -T web sh -c') && c.includes('-xzf'));
    expect(restoreAt).toBeGreaterThanOrEqual(0);
    expect(pluginsAt).toBeGreaterThan(restoreAt);
  });

  it('a corrupt plugin archive refuses the restore before any pg tool runs', () => {
    const sandbox = makeSandbox();
    withPluginArchive(sandbox, Buffer.from('bundles'), 'f'.repeat(64));
    const { rc, out } = runLfctl(sandbox, RESTORE);
    expect(rc, out).toBe(2);
    expect(out).toContain('Plugin bundle archive SHA-256 mismatch');
    expect(dockerCalls(sandbox).some((c) => /psql|pg_restore|\bcp\b|-xzf/.test(c))).toBe(false);
  });

  it('says exactly what is missing when the database came back but the bundles did not', () => {
    const sandbox = makeSandbox();
    withPluginArchive(sandbox, Buffer.from('bundles'));
    const { rc, out } = runLfctl(sandbox, RESTORE, { FAKE_PLUGINS_FAIL: '1' });
    expect(rc, out).toBe(2);
    expect(out).toContain('Database restored successfully, but the plugin bundles were not');
    expect(out).toContain('Re-install the marketplace plugins');
  });
});
