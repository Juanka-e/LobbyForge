#!/usr/bin/env node
import fs from 'node:fs/promises';
import { randomBytes, verify as verifySignature } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_CHANNEL = 'stable';
const DEFAULT_CURRENT_VERSION = '0.1.0';

function usage() {
  return `LobbyForge control CLI

Usage:
  node scripts/lfctl.mjs update check [--manifest <path-or-url>] [--current-version <version>] [--channel stable] [--public-key <pem-file>] [--json]
  node scripts/lfctl.mjs update plan  [--manifest <path-or-url>] [--current-version <version>] [--channel stable] [--public-key <pem-file>] [--json]
  node scripts/lfctl.mjs update apply [--manifest <path-or-url>] [--current-version <version>] [--channel stable] [--public-key <pem-file>] [--yes]
  node scripts/lfctl.mjs update rollback
  node scripts/lfctl.mjs backup verify [--manifest <path>] [--require-files] [--json]
  node scripts/lfctl.mjs backup create [--out <dir>] [--database-url <url>] [--json]
  node scripts/lfctl.mjs backup restore --file <dump> --to <database-url> [--json]
  node scripts/lfctl.mjs setup token [--json]

Notes:
  apply is intentionally locked until the self-host script runner is wired.
  The plan always requires a backup before compose pull/recreate steps.
`;
}

function parseArgs(argv) {
  const [domain, action, ...rest] = argv;
  const options = {
    channel: DEFAULT_CHANNEL,
    currentVersion: process.env.LOBBYFORGE_VERSION ?? DEFAULT_CURRENT_VERSION,
    json: false,
    yes: false,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--manifest') options.manifest = rest[++i];
    else if (arg === '--current-version') options.currentVersion = rest[++i];
    else if (arg === '--channel') options.channel = rest[++i];
    else if (arg === '--public-key') options.publicKeyPath = rest[++i];
    else if (arg === '--backup-manifest') options.backupManifest = rest[++i];
    else if (arg === '--require-files') options.requireFiles = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--yes') options.yes = true;
    // Backup create/restore options
    else if (arg === '--out') options.out = rest[++i];
    else if (arg === '--file') options.file = rest[++i];
    else if (arg === '--to') options['to'] = rest[++i];
    else if (arg === '--database-url') options['database-url'] = rest[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return { domain, action, options };
}

function validateBackupManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Backup manifest must be an object.');
  if (manifest.formatVersion !== 1) throw new Error('Backup manifest formatVersion must be 1.');
  if (typeof manifest.backupId !== 'string' || manifest.backupId.length === 0) {
    throw new Error('Backup manifest backupId is required.');
  }
  if (typeof manifest.createdAt !== 'string') throw new Error('Backup manifest createdAt is required.');
  if (typeof manifest.completed !== 'boolean') throw new Error('Backup manifest completed is required.');
  if (!manifest.databaseDump || typeof manifest.databaseDump !== 'object') {
    throw new Error('Backup manifest databaseDump is required.');
  }
  if (!manifest.includes || manifest.includes.database !== true) {
    throw new Error('Backup manifest includes.database must be true.');
  }
  return manifest;
}

async function loadBackupManifest(source = process.env.LOBBYFORGE_BACKUP_MANIFEST ?? 'infra/update/backup-manifest.example.json') {
  const absolute = path.resolve(process.cwd(), source);
  const raw = await fs.readFile(absolute, 'utf8');
  return { manifest: validateBackupManifest(JSON.parse(raw)), baseDir: path.dirname(absolute) };
}

async function exists(filePath, baseDir) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
  try {
    const stat = await fs.stat(resolved);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function verifyBackup(manifest, baseDir, options) {
  const createdAt = new Date(manifest.createdAt);
  const ageMs = Date.now() - createdAt.getTime();
  const checks = [
    { id: 'completed', ok: manifest.completed === true, message: 'Backup completed successfully.' },
    { id: 'createdAt.valid', ok: !Number.isNaN(createdAt.getTime()), message: 'Backup createdAt is a valid date.' },
    { id: 'createdAt.notFuture', ok: ageMs >= 0, message: 'Backup is not from the future.' },
    { id: 'createdAt.fresh', ok: ageMs >= 0 && ageMs <= 24 * 60 * 60 * 1000, message: 'Backup is fresh enough for update apply.' },
    { id: 'includes.database', ok: manifest.includes.database === true, message: 'Backup includes a database dump.' },
    {
      id: 'databaseDump.sha256',
      ok: /^[a-f0-9]{64}$/i.test(manifest.databaseDump.sha256),
      message: 'Database dump has a SHA-256 digest.',
    },
    {
      id: 'databaseDump.size',
      ok: typeof manifest.databaseDump.sizeBytes === 'number' && manifest.databaseDump.sizeBytes > 0,
      message: 'Database dump has non-zero size.',
    },
  ];
  if (options.requireFiles) {
    checks.push({
      id: 'databaseDump.exists',
      ok: await exists(manifest.databaseDump.path, baseDir),
      message: 'Database dump exists on disk.',
    });
  }
  return { ok: checks.every((item) => item.ok), backupId: manifest.backupId, createdAt: manifest.createdAt, ageMs, checks };
}

function printBackup(backup) {
  console.log(`Backup: ${backup.backupId}`);
  console.log(`Created: ${backup.createdAt}`);
  console.log(`Verified: ${backup.ok ? 'yes' : 'no'}`);
  for (const item of backup.checks) {
    console.log(`- ${item.ok ? 'ok' : 'fail'} ${item.id}: ${item.message}`);
  }
}

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] > right[key]) return 1;
    if (left[key] < right[key]) return -1;
  }
  return 0;
}

async function loadManifest(source) {
  if (!source) {
    const envSource = process.env.LOBBYFORGE_RELEASE_MANIFEST;
    if (!envSource) {
      throw new Error('Missing release manifest. Pass --manifest or set LOBBYFORGE_RELEASE_MANIFEST.');
    }
    source = envSource;
  }

  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
    return validateManifest(await res.json());
  }

  const absolute = path.resolve(process.cwd(), source);
  const raw = await fs.readFile(absolute, 'utf8');
  return validateManifest(JSON.parse(raw));
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Manifest must be an object.');
  if (typeof manifest.version !== 'string') throw new Error('Manifest version is required.');
  if (manifest.channel !== undefined && typeof manifest.channel !== 'string') {
    throw new Error('Manifest channel must be a string.');
  }
  if (manifest.releaseNotes !== undefined && typeof manifest.releaseNotes !== 'string') {
    throw new Error('Manifest releaseNotes must be a string.');
  }
  if (manifest.minimumVersion !== undefined && typeof manifest.minimumVersion !== 'string') {
    throw new Error('Manifest minimumVersion must be a string.');
  }
  if (manifest.signature !== undefined && typeof manifest.signature !== 'string') {
    throw new Error('Manifest signature must be a string.');
  }
  if (manifest.keyId !== undefined && typeof manifest.keyId !== 'string') {
    throw new Error('Manifest keyId must be a string.');
  }
  return manifest;
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => key !== 'signature').sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function base64urlToBuffer(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

async function loadPublicKey(options) {
  if (options.publicKeyPath) {
    return fs.readFile(path.resolve(process.cwd(), options.publicKeyPath), 'utf8');
  }
  return process.env.LOBBYFORGE_RELEASE_PUBLIC_KEY_PEM;
}

async function verifyManifestSignature(manifest, options) {
  const publicKeyPem = await loadPublicKey(options);
  if (!publicKeyPem) return { status: 'not_configured', verified: false, required: false };
  if (!manifest.signature) return { status: 'missing', verified: false, required: true };
  try {
    const ok = verifySignature(
      null,
      Buffer.from(canonicalize(manifest), 'utf8'),
      publicKeyPem,
      base64urlToBuffer(manifest.signature)
    );
    return ok
      ? { status: 'valid', verified: true, required: true, keyId: manifest.keyId }
      : { status: 'invalid', verified: false, required: true, keyId: manifest.keyId };
  } catch {
    return { status: 'invalid', verified: false, required: true, keyId: manifest.keyId };
  }
}

async function buildCheck(manifest, options) {
  const latestVersion = manifest.version;
  const currentVersion = options.currentVersion;
  const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
  const latest = parseVersion(latestVersion);
  const current = parseVersion(currentVersion);
  const majorUpgrade = latest.major > current.major;
  const currentSupported = manifest.minimumVersion
    ? compareVersions(currentVersion, manifest.minimumVersion) >= 0
    : true;

  return {
    channel: manifest.channel ?? options.channel,
    currentVersion,
    latestVersion,
    updateAvailable,
    majorUpgrade,
    currentSupported,
    releaseNotes: manifest.releaseNotes ?? '',
    breakingChanges: Array.isArray(manifest.breakingChanges) ? manifest.breakingChanges : [],
    signature: await verifyManifestSignature(manifest, options),
  };
}

function command(manifestCommand, fallback) {
  return typeof manifestCommand === 'string' && manifestCommand.trim() ? manifestCommand : fallback;
}

async function buildPlan(manifest, options) {
  const check = await buildCheck(manifest, options);
  const commands = manifest.commands && typeof manifest.commands === 'object' ? manifest.commands : {};
  const migrations = manifest.migrations && typeof manifest.migrations === 'object' ? manifest.migrations : {};

  const steps = [
    {
      id: 'preflight-doctor',
      title: 'Run Doctor preflight',
      required: true,
      command: command(commands.doctor, 'lfctl doctor'),
    },
    {
      id: 'backup',
      title: 'Create database/config backup',
      required: true,
      command: command(commands.backup, 'lfctl backup create'),
    },
    {
      id: 'pull-images',
      title: 'Pull new Docker images',
      required: true,
      command: command(commands.composePull, 'docker compose pull'),
    },
    {
      id: 'migration-dry-run',
      title: 'Review migration plan',
      required: true,
      command: command(migrations.dryRunCommand, 'pnpm --filter @lobbyforge/db db:generate -- --dry-run'),
    },
    {
      id: 'apply-migrations',
      title: 'Apply database migrations',
      required: true,
      command: command(migrations.applyCommand, 'pnpm --filter @lobbyforge/db db:migrate'),
    },
    {
      id: 'recreate-services',
      title: 'Recreate services',
      required: true,
      command: command(commands.composeUp, 'docker compose up -d --remove-orphans'),
    },
    {
      id: 'health-check',
      title: 'Run health smoke test',
      required: true,
      command: command(commands.healthCheck, 'curl -fsS http://localhost:3000/api/health'),
    },
  ];

  return {
    ...check,
    safeToAutoApply: false,
    requiresAdminConfirmation: true,
    requiresExtraMajorConfirmation: check.majorUpgrade,
    rollbackCommand: command(commands.rollback, 'docker compose up -d --remove-orphans'),
    steps,
  };
}

function printCheck(check) {
  console.log(`Channel: ${check.channel}`);
  console.log(`Current: ${check.currentVersion}`);
  console.log(`Latest:  ${check.latestVersion}`);
  console.log(`Update available: ${check.updateAvailable ? 'yes' : 'no'}`);
  console.log(`Major upgrade: ${check.majorUpgrade ? 'yes' : 'no'}`);
  console.log(`Current version supported: ${check.currentSupported ? 'yes' : 'no'}`);
  console.log(`Manifest signature: ${check.signature.status}`);
  if (check.releaseNotes) console.log(`\nRelease notes:\n${check.releaseNotes}`);
  if (check.breakingChanges.length > 0) {
    console.log('\nBreaking changes:');
    for (const item of check.breakingChanges) console.log(`- ${item}`);
  }
}

function printPlan(plan) {
  printCheck(plan);
  console.log('\nUpdate plan:');
  for (const step of plan.steps) {
    console.log(`- ${step.title}`);
    console.log(`  ${step.command}`);
  }
  console.log(`\nRollback command: ${plan.rollbackCommand}`);
  console.log('Auto-apply: locked until the self-host script runner is wired.');
}

async function main() {
  const { domain, action, options } = parseArgs(process.argv.slice(2));
  if (!domain || domain === '--help' || domain === '-h') {
    console.log(usage());
    return;
  }
  if (domain === 'backup') {
    if (action === 'create') {
      const out = await backupCreate(options);
      if (options.json) console.log(JSON.stringify(out, null, 2));
      else {
        console.log(`Backup created: ${out.file}`);
        console.log(`SHA-256: ${out.sha256}`);
      }
      return;
    }
    if (action === 'restore') {
      if (!options.file) throw new Error('backup restore requires --file <path-to-dump>');
      if (!options['to']) throw new Error('backup restore requires --to <empty-database-url>');
      const out = await backupRestore(options.file, options['to']);
      if (options.json) console.log(JSON.stringify(out, null, 2));
      else {
        console.log(`Restore ${out.ok ? 'completed' : 'FAILED'}: ${out.message}`);
      }
      if (!out.ok) process.exitCode = 2;
      return;
    }
    if (action !== 'verify') throw new Error(`Unknown backup action: ${action ?? '(missing)'}`);
    const { manifest, baseDir } = await loadBackupManifest(options.manifest);
    const backup = await verifyBackup(manifest, baseDir, options);
    if (options.json) console.log(JSON.stringify({ backup }, null, 2));
    else printBackup(backup);
    if (!backup.ok) process.exitCode = 2;
    return;
  }

  if (domain === 'setup') {
    if (action !== 'token') throw new Error(`Unknown setup action: ${action ?? '(missing)'}`);
    const token = randomBytes(32).toString('hex');
    if (options.json) console.log(JSON.stringify({ setupToken: token }));
    else {
      console.log('Generated one-time setup token:');
      console.log(token);
      console.log('\nSet LOBBYFORGE_SETUP_TOKEN before exposing the instance. Rotate or remove it after setup.');
    }
    return;
  }

  if (domain !== 'update') throw new Error(`Unknown command domain: ${domain}`);

  if (action === 'rollback') {
    console.log('Rollback execution is locked until the self-host script runner is wired.');
    process.exitCode = 2;
    return;
  }

  if (!['check', 'plan', 'apply'].includes(action)) {
    throw new Error(`Unknown update action: ${action ?? '(missing)'}`);
  }

  const manifest = await loadManifest(options.manifest);
  if (action === 'check') {
    const check = await buildCheck(manifest, options);
    if (options.json) console.log(JSON.stringify(check, null, 2));
    else printCheck(check);
    return;
  }

  const plan = await buildPlan(manifest, options);
  if (action === 'plan') {
    if (options.json) console.log(JSON.stringify(plan, null, 2));
    else printPlan(plan);
    return;
  }

  printPlan(plan);
  const { manifest: backupManifest, baseDir } = await loadBackupManifest(options.backupManifest);
  const backup = await verifyBackup(backupManifest, baseDir, options);
  printBackup(backup);
  console.error('\nRefusing to execute update: apply requires the future script runner and backup artifact verification.');
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

// ── Backup create / restore ──────────────────────────────────────────
// Real pg_dump-based backup with SHA-256 checksum, and restore into an
// empty database. Both require pg_dump/pg_restore on PATH (ships with
// the postgres client package inside the Docker image).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const execFileAsync = promisify(execFile);

async function backupCreate(options = {}) {
  const outDir = options.out ?? 'backups';
  const dbUrl = options['database-url'] ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('backup create requires --database-url or DATABASE_URL');

  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `lobbyforge-${stamp}.dump`);

  // pg_dump custom format (-Fc) — compressed, supports parallel restore + selective tables.
  await execFileAsync('pg_dump', ['-Fc', '-f', file, dbUrl], { timeout: 300_000 });

  const buf = await fs.readFile(file);
  const sha256 = createHash('sha256').update(buf).digest('hex');

  // Write a sidecar manifest with metadata for verify.
  const meta = {
    file: path.basename(file),
    sha256,
    sizeBytes: buf.length,
    createdAt: new Date().toISOString(),
    databaseUrlPrefix: dbUrl.split('@').pop()?.split('/')[0] ?? 'unknown-host',
  };
  await fs.writeFile(`${file}.json`, JSON.stringify(meta, null, 2));

  return { file, sha256, sizeBytes: buf.length };
}

async function backupRestore(file, targetUrl) {
  try {
    // Verify checksum if sidecar manifest exists.
    try {
      const sidecar = JSON.parse(await fs.readFile(`${file}.json`, 'utf8'));
      const buf = await fs.readFile(file);
      const actual = createHash('sha256').update(buf).digest('hex');
      if (sidecar.sha256 && actual !== sidecar.sha256) {
        return { ok: false, message: 'SHA-256 mismatch — dump may be corrupted.' };
      }
    } catch {
      // No sidecar — proceed without checksum verification.
    }

    // Safety: refuse to restore into a database that already has tables.
    const { stdout } = await execFileAsync('psql', [targetUrl, '-tAc',
      "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"], { timeout: 30_000 });
    if (parseInt(stdout.trim(), 10) > 0) {
      return { ok: false, message: 'Target database is not empty. Restore requires an empty database.' };
    }

    await execFileAsync('pg_restore', ['--no-owner', '--no-privileges', '-d', targetUrl, file], { timeout: 600_000 });
    return { ok: true, message: 'Database restored successfully.' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
