import fs from 'node:fs/promises';
import path from 'node:path';

export interface BackupArtifact {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface BackupManifest {
  formatVersion: 1;
  backupId: string;
  createdAt: string;
  appVersion: string;
  completed: boolean;
  databaseDump: BackupArtifact;
  includes: {
    database: boolean;
    uploads?: boolean;
    env?: boolean;
    pluginSettings?: boolean;
    registryConfig?: boolean;
  };
  files?: BackupArtifact[];
}

export interface BackupVerification {
  ok: boolean;
  backupId?: string;
  createdAt?: string;
  ageMs?: number;
  checks: { id: string; ok: boolean; message: string }[];
}

export interface BackupVerifyOptions {
  baseDir?: string;
  now?: Date;
  maxAgeMs?: number;
  requireFileExists?: boolean;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const DEFAULT_BACKUP_MANIFEST_PATH = 'infra/update/backup-manifest.example.json';

function check(id: string, ok: boolean, message: string): BackupVerification['checks'][number] {
  return { id, ok, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isArtifact(value: unknown): value is BackupArtifact {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.sha256 === 'string' &&
    typeof value.sizeBytes === 'number'
  );
}

export function validateBackupManifest(value: unknown): BackupManifest {
  if (!isRecord(value)) throw new Error('Backup manifest must be an object.');
  if (value.formatVersion !== 1) throw new Error('Backup manifest formatVersion must be 1.');
  if (typeof value.backupId !== 'string' || value.backupId.length === 0) {
    throw new Error('Backup manifest backupId is required.');
  }
  if (typeof value.createdAt !== 'string') throw new Error('Backup manifest createdAt is required.');
  if (typeof value.appVersion !== 'string') throw new Error('Backup manifest appVersion is required.');
  if (typeof value.completed !== 'boolean') throw new Error('Backup manifest completed is required.');
  if (!isArtifact(value.databaseDump)) throw new Error('Backup manifest databaseDump is required.');
  if (!isRecord(value.includes) || typeof value.includes.database !== 'boolean') {
    throw new Error('Backup manifest includes.database is required.');
  }
  if (value.files !== undefined && !Array.isArray(value.files)) {
    throw new Error('Backup manifest files must be an array.');
  }
  if (Array.isArray(value.files) && !value.files.every(isArtifact)) {
    throw new Error('Backup manifest files must contain backup artifacts.');
  }
  return value as unknown as BackupManifest;
}

async function fileExists(artifactPath: string, baseDir: string | undefined): Promise<boolean> {
  if (!baseDir) return false;
  const root = path.resolve(baseDir);
  const resolved = path.resolve(root, artifactPath);
  const relative = path.relative(root, resolved);
  if (path.isAbsolute(artifactPath) || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  try {
    const stat = await fs.stat(resolved);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function verifyArtifact(
  artifact: BackupArtifact,
  idPrefix: string,
  checks: BackupVerification['checks'],
  options: BackupVerifyOptions
): Promise<void> {
  checks.push(check(`${idPrefix}.sha256`, SHA256_RE.test(artifact.sha256), `${idPrefix} has a SHA-256 digest.`));
  checks.push(check(`${idPrefix}.size`, artifact.sizeBytes > 0, `${idPrefix} has non-zero size.`));
  if (options.requireFileExists) {
    checks.push(
      check(
        `${idPrefix}.exists`,
        await fileExists(artifact.path, options.baseDir),
        `${idPrefix} artifact exists on disk.`
      )
    );
  }
}

export async function verifyBackupManifest(
  manifest: BackupManifest,
  options: BackupVerifyOptions = {}
): Promise<BackupVerification> {
  const now = options.now ?? new Date();
  const createdAt = new Date(manifest.createdAt);
  const ageMs = now.getTime() - createdAt.getTime();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const checks: BackupVerification['checks'] = [
    check('completed', manifest.completed, 'Backup completed successfully.'),
    check('createdAt.valid', !Number.isNaN(createdAt.getTime()), 'Backup createdAt is a valid date.'),
    check('createdAt.notFuture', ageMs >= 0, 'Backup is not from the future.'),
    check('createdAt.fresh', ageMs >= 0 && ageMs <= maxAgeMs, 'Backup is fresh enough for update apply.'),
    check('includes.database', manifest.includes.database, 'Backup includes a database dump.'),
  ];

  await verifyArtifact(manifest.databaseDump, 'databaseDump', checks, options);
  for (const [index, artifact] of (manifest.files ?? []).entries()) {
    await verifyArtifact(artifact, `files.${index}`, checks, options);
  }

  return {
    ok: checks.every((item) => item.ok),
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    ageMs,
    checks,
  };
}

export async function loadBackupManifest(source?: string): Promise<{ manifest: BackupManifest; baseDir: string }> {
  const manifestSource =
    source ??
    process.env.LOBBYFORGE_BACKUP_MANIFEST ??
    DEFAULT_BACKUP_MANIFEST_PATH;
  if (path.isAbsolute(manifestSource)) {
    throw new Error('Backup manifest paths must be relative to infra/update.');
  }
  const relativeSource = manifestSource.replace(/^infra[\\/]update[\\/]/, '');
  const roots = [
    path.join(/* turbopackIgnore: true */ process.cwd(), 'infra', 'update'),
    path.join(/* turbopackIgnore: true */ process.cwd(), '..', '..', 'infra', 'update'),
  ];
  let lastError: unknown;
  for (const root of [...new Set(roots)]) {
    const absolute = path.resolve(root, relativeSource);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Backup manifest must stay inside infra/update.');
    }
    try {
      const raw = await fs.readFile(absolute, 'utf8');
      return {
        manifest: validateBackupManifest(JSON.parse(raw)),
        baseDir: path.dirname(absolute),
      };
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw lastError;
}
