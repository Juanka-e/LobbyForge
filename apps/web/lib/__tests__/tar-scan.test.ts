/**
 * 14th-audit: the tar header scanner. The old `tar -tv` regex missed
 * REAL GNU tar output (the audit's example line didn't match), so the
 * bomb/symlink/traversal pre-checks silently skipped every entry. These
 * tests exercise parseTarHeaders against hand-built tar archives — the
 * 512-byte ustar format — proving every rule now actually fires.
 */
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { scanTarEntries } from '../plugin-installer';

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
