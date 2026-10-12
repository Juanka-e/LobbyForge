/**
 * 14th-audit: the tar header scanner. The old `tar -tv` regex missed
 * REAL GNU tar output (the audit's example line didn't match), so the
 * bomb/symlink/traversal pre-checks silently skipped every entry. These
 * tests exercise parseTarHeaders against hand-built tar archives — the
 * 512-byte ustar format — proving every rule now actually fires.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertNoEscapingSymlinks, scanTarEntries } from '../plugin-installer';

function tarHeader(name: string, size: number, typeflag: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  h[156] = typeflag.charCodeAt(0);
  // Checksum: spaces then sum of all bytes.
  h.fill(0x20, 148, 156);
  const sum = h.reduce((acc, b) => acc + b, 0);
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return h;
}

function makeTar(entries: Array<{ name: string; size?: number; typeflag?: string; data?: Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const size = e.data?.length ?? e.size ?? 0;
    blocks.push(tarHeader(e.name, size, e.typeflag ?? '0'));
    if (e.data && e.data.length > 0) {
      const pad = Buffer.alloc(Math.ceil(e.data.length / 512) * 512 - e.data.length);
      blocks.push(e.data, pad);
    }
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks = end
  return Buffer.concat(blocks);
}

function tgz(entries: Array<{ name: string; size?: number; typeflag?: string; data?: Buffer }>): Buffer {
  return gzipSync(makeTar(entries));
}

import { gzipSync } from 'node:zlib';

describe('scanTarEntries (programmatic ustar scan)', () => {
  it('counts regular files and directories exactly', () => {
    const result = scanTarEntries(
      tgz([
        { name: 'pkg/', typeflag: '5' },
        { name: 'pkg/index.js', data: Buffer.alloc(100) },
        { name: 'pkg/extra.js', data: Buffer.alloc(200) },
      ])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.entries).toHaveLength(3);
    expect(result.totalBytes).toBe(300);
  });

  it('REJECTS a symlink entry (the old regex skipped these)', () => {
    const result = scanTarEntries(
      tgz([
        { name: 'pkg/', typeflag: '5' },
        { name: 'pkg/index.js', data: Buffer.alloc(10) },
        { name: 'pkg/evil', typeflag: '2', size: 8 }, // symlink → /etc
      ])
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('non-regular');
  });

  it('REJECTS a hardlink entry', () => {
    const result = scanTarEntries(
      tgz([{ name: 'pkg/hard', typeflag: '1', size: 0 }])
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('non-regular');
  });

  it('REJECTS path traversal', () => {
    const result = scanTarEntries(
      tgz([{ name: '../../../etc/passwd', data: Buffer.alloc(5) }])
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('unsafe path');
  });

  it('REJECTS absolute paths', () => {
    const result = scanTarEntries(
      tgz([{ name: '/etc/shadow', data: Buffer.alloc(5) }])
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('unsafe path');
  });

  it('REJECTS a decompression bomb (every entry now counted)', () => {
    // 3 × 20 MiB entries = 60 MiB total > 50 MiB cap.
    const big = Buffer.alloc(20 * 1024 * 1024);
    const result = scanTarEntries(
      tgz([
        { name: 'pkg/a', data: big },
        { name: 'pkg/b', data: big },
        { name: 'pkg/c', data: big },
      ])
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('tar bomb');
  });

  it('REJECTS too many entries', () => {
    const entries = Array.from({ length: 501 }, (_, i) => ({
      name: `pkg/f${i}`,
      data: Buffer.alloc(1),
    }));
    const result = scanTarEntries(tgz(entries));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('entries');
  });
});

/**
 * Security follow-up: ustar splits a long path into `prefix` (offset 345,
 * 155 bytes) + `name`, and tar extracts to `prefix/name`. A traversal in
 * the prefix must be caught like one in the name.
 */
function ustarHeader(prefix: string, name: string, size: number, magic = 'ustar\u000000'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  h[156] = '0'.charCodeAt(0);
  h.write(magic, 257, 8, 'latin1');
  h.write(prefix, 345, 155, 'utf8');
  h.fill(0x20, 148, 156);
  const sum = h.reduce((acc, b) => acc + b, 0);
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return h;
}

function ustarTgz(prefix: string, name: string, magic?: string): Buffer {
  const data = Buffer.alloc(512);
  return gzipSync(Buffer.concat([ustarHeader(prefix, name, 5, magic), data, Buffer.alloc(1024)]));
}

describe('scanTarEntries — ustar prefix field', () => {
  it.each([
    ['../../../etc', 'passwd'],
    ['pkg/../..', 'index.js'],
    ['/etc', 'shadow'],
    ['pkg\\..', 'index.js'],
  ])('REJECTS prefix %j + name %j', (prefix, name) => {
    const result = scanTarEntries(ustarTgz(prefix, name));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('unsafe path');
  });

  it('checks the prefix in GNU-magic headers too', () => {
    const result = scanTarEntries(ustarTgz('../..', 'x', 'ustar  \u0000'));
    expect(result.ok).toBe(false);
  });

  it('still rejects an absolute name behind a harmless prefix', () => {
    const result = scanTarEntries(ustarTgz('pkg', '/etc/shadow'));
    expect(result.ok).toBe(false);
  });

  it('reports the joined path and accepts a safe prefix', () => {
    const result = scanTarEntries(ustarTgz('package/some/long/dir', 'index.js'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.entries[0]!.name).toBe('package/some/long/dir/index.js');
  });
});

/**
 * Security review PLUG-001: the scan is reached from the review route with a
 * downloaded bundle; a small gzip must never be inflated in full.
 */
describe('scanTarEntries — bounded decompression (PLUG-001)', () => {
  it('refuses a small gzip that inflates past the cap, without inflating it in full', () => {
    // 256 members of 1 MiB of zeros: ~260 KB of gzip, 256 MiB once inflated.
    const member = gzipSync(Buffer.alloc(1024 * 1024), { level: 9 });
    const bomb = Buffer.concat(Array.from({ length: 256 }, () => member));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    const before = process.memoryUsage().arrayBuffers;
    const result = scanTarEntries(bomb);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('tar bomb');
    // Decompression stopped near the ~51 MB archive cap, nowhere near 256 MiB.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(128 * 1024 * 1024);
  });

  it('refuses a compressed bundle over the installer’s 10 MB cap before decompressing', () => {
    const result = scanTarEntries(Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toBe('Bundle exceeds 10485760 bytes');
  });
});

/** A header with a hand-written size field, checksummed as given (or not). */
function rawHeader(name: string, sizeField: Buffer, options: { checksum?: 'ok' | 'bad' | 'signed' } = {}): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  sizeField.copy(h, 124, 0, 12);
  h[156] = '0'.charCodeAt(0);
  h.fill(0x20, 148, 156);
  let unsigned = 0;
  let signed = 0;
  for (const b of h) {
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  const sum = options.checksum === 'signed' ? signed : options.checksum === 'bad' ? unsigned + 1 : unsigned;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return h;
}

function field(text: string): Buffer {
  const f = Buffer.alloc(12);
  f.write(text, 0, 12, 'latin1');
  return f;
}

function scanOne(header: Buffer, data: Buffer = Buffer.alloc(512)) {
  return scanTarEntries(gzipSync(Buffer.concat([header, data, Buffer.alloc(1024)])));
}

describe('parseTarHeaders — strict numeric fields and checksum (PLUG-003)', () => {
  it('accepts the forms tar writes: zero-padded, space-led, NUL- or space-terminated', () => {
    for (const text of ['00000000005\0', '00000000005 ', '          5\0', '5\0\0\0\0\0\0\0\0\0\0\0', '000000000005']) {
      const result = scanOne(rawHeader('pkg/a', field(text)));
      expect(result.ok, JSON.stringify(text)).toBe(true);
      if (result.ok) expect(result.entries[0]!.sizeBytes).toBe(5);
    }
  });

  it.each([
    ['digits after a terminator', '0000 0000005'],
    ['a NUL inside the digits', '00000\u0000000005'],
    ['a non-octal digit', '00000000009\0'],
    ['letters', '0000000000x\0'],
    ['a sign', '+0000000005\0'],
    ['an empty field', '\0\0\0\0\0\0\0\0\0\0\0\0'],
    ['only spaces', '            '],
  ])('refuses a size field with %s', (_label, text) => {
    const result = scanOne(rawHeader('pkg/a', field(text)));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toMatch(/size field/);
  });

  it('refuses a GNU base-256 size explicitly', () => {
    const size = Buffer.alloc(12);
    size[0] = 0x80;
    size[11] = 5;
    const result = scanOne(rawHeader('pkg/a', size));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('base-256');
  });

  it('refuses a header whose checksum does not match', () => {
    const result = scanOne(rawHeader('pkg/a', field('00000000005\0'), { checksum: 'bad' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('checksum');
  });

  it('accepts the signed checksum old tars wrote, like GNU tar does', () => {
    // A byte above 127 makes the signed and unsigned sums differ.
    const result = scanOne(rawHeader('pkg/é', field('00000000005\0'), { checksum: 'signed' }));
    expect(result.ok).toBe(true);
  });

  it('refuses an entry whose data runs past the end of the archive', () => {
    const header = rawHeader('pkg/a', field('00000002000\0')); // 1024 bytes of data
    const result = scanTarEntries(gzipSync(Buffer.concat([header, Buffer.alloc(512)])));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('truncated');
  });

  it('a corrupted size can no longer hide an entry behind a misread boundary', () => {
    // The old reader read "0000000x005" as 0 and took the data block for the
    // next header, so a forged header there was scanned instead of the data.
    const forged = tarHeader('pkg/forged', 5, '0');
    const result = scanOne(rawHeader('pkg/a', field('0000000x005\0')), forged);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toMatch(/size field/);
  });
});

describe('assertNoEscapingSymlinks — the post-extraction walk (PLUG-003)', () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'lf-tar-walk-'));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /** A directory link: a junction on Windows, which needs no privilege. */
  function link(target: string, path: string): boolean {
    try {
      symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    } catch {
      return false;
    }
  }

  it('finds a link far below the old depth cap of 10', () => {
    const deep = join(work, ...Array.from({ length: 25 }, (_, i) => `d${i}`));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'file.txt'), 'x');
    expect(() => assertNoEscapingSymlinks(work)).not.toThrow();
    const target = mkdtempSync(join(tmpdir(), 'lf-tar-walk-target-'));
    try {
      if (!link(target, join(deep, 'escape'))) return; // no link support on this machine
      expect(() => assertNoEscapingSymlinks(work)).toThrow(/symlink/);
    } finally {
      rmSync(join(deep, 'escape'), { recursive: false, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('no longer swallows a walk error', () => {
    expect(() => assertNoEscapingSymlinks(join(work, 'missing'))).toThrow(/ENOENT/);
  });
});
