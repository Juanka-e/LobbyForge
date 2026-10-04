/**
 * The example plugin's pack script (examples/plugins/sandbox-buzzer/pack.mjs)
 * produces what the installer accepts: a gzip'd ustar archive that passes
 * the security scan, with manifest.json and server.js at the bundle root
 * once tar strips the first component, and a matching .sha256. The archive
 * is reproducible, so the pinned digest can be re-derived from the source.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleRootFiles, missingSandboxRootFiles, scanTarEntries } from '../plugin-installer';

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(here, '..', '..', '..', '..', 'examples', 'plugins', 'sandbox-buzzer');
const PACK = join(EXAMPLE, 'pack.mjs');

let work: string;

/** A copy of the example with a stub UI (MKT-CLIENT owns the real ui/). */
function prepare(withUi = true): string {
  const dir = join(work, `bundle-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(EXAMPLE, 'manifest.json'), join(dir, 'manifest.json'));
  copyFileSync(join(EXAMPLE, 'server.js'), join(dir, 'server.js'));
  if (withUi) {
    mkdirSync(join(dir, 'ui', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'ui', 'index.html'), '<!doctype html><script src="./assets/app.js"></script>');
    writeFileSync(join(dir, 'ui', 'assets', 'app.js'), 'console.log(1);');
  }
  return dir;
}

function pack(dir: string, out: string) {
  return spawnSync(process.execPath, [PACK, dir, '--out', out], { encoding: 'utf8' });
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'lf-pack-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('examples/plugins/sandbox-buzzer/pack.mjs', () => {
  it('writes a tarball the installer scan accepts, with the sandbox-v1 files at the root', () => {
    const dir = prepare();
    const out = join(work, 'dist');
    const run = pack(dir, out);
    expect(run.status, run.stderr).toBe(0);
    const summary = JSON.parse(run.stdout) as { file: string; sha256: string; sizeBytes: number; entries: string[] };
    expect(summary.entries).toEqual(['./manifest.json', './server.js', './ui/', './ui/assets/', './ui/assets/app.js', './ui/index.html']);

    const tgz = readFileSync(join(out, 'sandbox-buzzer-0.1.0.tgz'));
    expect(summary.sizeBytes).toBe(tgz.length);
    expect(createHash('sha256').update(tgz).digest('hex')).toBe(summary.sha256);
    expect(readFileSync(join(out, 'sandbox-buzzer-0.1.0.tgz.sha256'), 'utf8')).toBe(`${summary.sha256}  sandbox-buzzer-0.1.0.tgz\n`);

    const scan = scanTarEntries(tgz);
    expect(scan.ok, scan.ok ? '' : scan.error).toBe(true);
    if (!scan.ok) return;
    expect(missingSandboxRootFiles(scan.entries)).toBeNull();
    expect([...bundleRootFiles(scan.entries)].sort()).toEqual(['manifest.json', 'server.js']);
  });

  it('is reproducible: the same sources give the same bytes', () => {
    const dir = prepare();
    expect(pack(dir, join(work, 'a')).status).toBe(0);
    expect(pack(dir, join(work, 'b')).status).toBe(0);
    const a = readFileSync(join(work, 'a', 'sandbox-buzzer-0.1.0.tgz'));
    const b = readFileSync(join(work, 'b', 'sandbox-buzzer-0.1.0.tgz'));
    expect(a.equals(b)).toBe(true);
  });

  it('root files follow tar --strip-components=1, and old-style (NUL typeflag) regular files count', () => {
    const entry = (name: string, typeflag: string) => ({ name, pathFields: [name], sizeBytes: 1, typeflag });
    expect(missingSandboxRootFiles([entry('./manifest.json', '\0'), entry('./server.js', '\0')])).toBeNull();
    expect(missingSandboxRootFiles([entry('pkg/manifest.json', '0'), entry('pkg/server.js', '0')])).toBeNull();
    // A bare name is stripped away by tar; a nested one is not at the root.
    expect(missingSandboxRootFiles([entry('manifest.json', '0'), entry('server.js', '0')])).toMatch(/archive root/);
    expect(missingSandboxRootFiles([entry('./manifest.json', '0'), entry('./src/server.js', '0')])).toMatch(/archive root/);
    // Directories never count as files.
    expect(missingSandboxRootFiles([entry('./manifest.json', '0'), entry('./server.js', '5')])).toMatch(/archive root/);
    expect(missingSandboxRootFiles([entry('./index.js', '0')])).toMatch(/legacy Node bundle/);
  });

  it('refuses a manifest that says ui: true when ui/index.html is missing', () => {
    const run = pack(prepare(false), join(work, 'dist'));
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/ui\/index\.html is missing/);
  });
});
