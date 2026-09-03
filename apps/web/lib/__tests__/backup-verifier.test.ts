import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateBackupManifest,
  verifyBackupManifest,
  type BackupManifest,
} from '@/lib/backup-verifier';

const baseManifest: BackupManifest = {
  formatVersion: 1,
  backupId: 'backup-1',
  createdAt: '2026-06-11T10:00:00.000Z',
  appVersion: '0.1.0',
  completed: true,
  databaseDump: {
    path: 'postgres.dump',
    sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sizeBytes: 1024,
  },
  includes: {
    database: true,
    pluginSettings: true,
    registryConfig: true,
  },
  files: [],
};

describe('backup verifier', () => {
  it('verifies a fresh completed backup manifest', async () => {
    const result = await verifyBackupManifest(baseManifest, {
      now: new Date('2026-06-11T11:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
  });

  it('fails stale backups', async () => {
    const result = await verifyBackupManifest(baseManifest, {
      now: new Date('2026-06-13T11:00:00.000Z'),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((item) => item.id === 'createdAt.fresh')?.ok).toBe(false);
  });

  it('fails invalid database digests', async () => {
    const result = await verifyBackupManifest({
      ...baseManifest,
      databaseDump: { ...baseManifest.databaseDump, sha256: 'bad' },
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((item) => item.id === 'databaseDump.sha256')?.ok).toBe(false);
  });

  it('verifies the REAL file digest and size when requireFileExists (OPS-002)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lf-backup-'));
    const content = 'backup';
    const { createHash } = await import('node:crypto');
    const realSha = createHash('sha256').update(content).digest('hex');
    const manifest: BackupManifest = {
      ...baseManifest,
      databaseDump: { path: 'postgres.dump', sha256: realSha, sizeBytes: content.length },
    };
    await writeFile(path.join(dir, 'postgres.dump'), content);
    const result = await verifyBackupManifest(manifest, {
      baseDir: dir,
      requireFileExists: true,
      now: new Date('2026-06-11T11:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.id === 'databaseDump.sha256.match')?.ok).toBe(true);
    expect(result.checks.find((c) => c.id === 'databaseDump.size.match')?.ok).toBe(true);
  });

  it('FAILS when the real file digest does not match the manifest', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lf-backup-'));
    await writeFile(path.join(dir, 'postgres.dump'), 'tampered-content');
    const result = await verifyBackupManifest(baseManifest, {
      baseDir: dir,
      requireFileExists: true,
      now: new Date('2026-06-11T11:00:00.000Z'),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === 'databaseDump.sha256.match')?.ok).toBe(false);
  });

  it('rejects malformed manifests', () => {
    expect(() => validateBackupManifest({ formatVersion: 1 })).toThrow(/backupId/);
  });
});
