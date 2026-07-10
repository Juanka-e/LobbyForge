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

  it('can require the backup artifact to exist', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lf-backup-'));
    await writeFile(path.join(dir, 'postgres.dump'), 'backup');
    const result = await verifyBackupManifest(baseManifest, {
      baseDir: dir,
      requireFileExists: true,
      now: new Date('2026-06-11T11:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
  });

  it('rejects malformed manifests', () => {
    expect(() => validateBackupManifest({ formatVersion: 1 })).toThrow(/backupId/);
  });
});
