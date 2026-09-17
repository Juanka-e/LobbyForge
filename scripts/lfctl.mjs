#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify as verifySignature } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { promisify } from 'node:util';

const DEFAULT_CHANNEL = 'stable';
// 21st-audit: check/plan/apply work with NO arguments — the documented
// chain must run verbatim. Forks point this (or per-invocation --manifest)
// at their own releases.
const DEFAULT_MANIFEST_URL = 'https://github.com/Juanka-e/LobbyForge/releases/latest/download/release-manifest.json';
// The official release public key ships in the repo — pinned by default so
// unsigned/tampered manifests fail closed out of the box.
const DEFAULT_PUBLIC_KEY_PATH = 'infra/update/release-public.pem';
const ENV_FILE = '.env.prod';
const COMPOSE_FILE = 'infra/docker/docker-compose.prod.yml';
const STATE_FILE = 'infra/update/deployment-state.json';

// 21st-audit (drill-caught TDZ): main() is invoked mid-file and the
// backup path runs SYNCHRONOUSLY up to its first await — the pg runtime
// MUST be initialized here at the top, before main() executes. Declaring
// these in the bottom-of-file backup section crashed `backup create`
// with "Cannot access 'PG_CONTAINER' before initialization".
const execFileAsync = promisify(execFile);
let PG_CONTAINER = process.env.LFCTL_PG_CONTAINER ?? '';

// Docker invocation prefix — LFCTL_DOCKER overrides the binary and may
// carry a launcher (e.g. "bash /path/to/fake-docker" in the recovery
// regression tests; operators can point at a docker wrapper too).
const DOCKER_PREFIX = (process.env.LFCTL_DOCKER ?? 'docker').split(/\s+/).filter(Boolean);
function dockerArgs(args) {
  return [...DOCKER_PREFIX.slice(1), ...args];
}

function usage() {
  return `LobbyForge control CLI

Usage:
  node scripts/lfctl.mjs update check [--manifest <path-or-url>] [--current-version <version>] [--channel stable] [--public-key <pem-file>] [--json]
  node scripts/lfctl.mjs update plan  [--manifest <path-or-url>] [--current-version <version>] [--channel stable] [--public-key <pem-file>] [--json]
  node scripts/lfctl.mjs update apply [--manifest <path-or-url>] [--backup-manifest <path>] [--current-version <version>] [--channel stable] [--public-key <pem-file>] [--yes] [--force-major]
  node scripts/lfctl.mjs update rollback
  node scripts/lfctl.mjs backup verify [--manifest <path>] [--require-files] [--json]
  node scripts/lfctl.mjs backup create [--out <dir>] [--database-url <url>] [--json]
  node scripts/lfctl.mjs backup restore --file <dump> --to <database-url> [--allow-unverified] [--json]
  node scripts/lfctl.mjs setup token [--json]
  node scripts/lfctl.mjs directory keygen [--out <dir>] [--json]
  node scripts/lfctl.mjs directory heartbeat --url <directory-origin> --instance-id <id> --key-file <pem>
      [--online-users N] [--public-rooms N] [--stats-version V] [--doctor-score N]
      [--once | --interval <seconds>] [--json]

Notes:
  update check/plan/apply default to the official latest release manifest
  (${DEFAULT_MANIFEST_URL}); override with --manifest or
  LOBBYFORGE_RELEASE_MANIFEST (forks).
  Signature verification defaults to the committed official public key
  (${DEFAULT_PUBLIC_KEY_PATH}); override with --public-key.
  update apply creates + verifies a FRESH backup automatically unless
  --backup-manifest points at an existing one. Deployed version state is
  read from .env.prod/deployment-state.json (no hardcoded current version).
  update rollback restores the previous recorded image+version (app-level;
  DB migrations are forward-only — restore the pre-update backup if a
  release shipped breaking migrations).
  Add --force-major for major version upgrades.
`;
}

function parseArgs(argv) {
  const [domain, action, ...rest] = argv;
  const options = {
    channel: DEFAULT_CHANNEL,
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
    else if (arg === '--force-major') options.forceMajor = true;
    // Backup create/restore options
    else if (arg === '--out') options.out = rest[++i];
    else if (arg === '--file') options.file = rest[++i];
    else if (arg === '--to') options['to'] = rest[++i];
    else if (arg === '--allow-unverified') options['allow-unverified'] = true;
    else if (arg === '--database-url') options['database-url'] = rest[++i];
    // Directory heartbeat options (LF-SEC-007)
    else if (arg === '--url') options.url = rest[++i];
    else if (arg === '--domain') options.url = rest[++i];
    else if (arg === '--instance-id') options.instanceId = rest[++i];
    else if (arg === '--key-file') options.keyFile = rest[++i];
    else if (arg === '--online-users') options.onlineUsers = Number(rest[++i]);
    else if (arg === '--public-rooms') options.publicRooms = Number(rest[++i]);
    else if (arg === '--stats-version') options.statsVersion = rest[++i];
    else if (arg === '--doctor-score') options.doctorScore = Number(rest[++i]);
    else if (arg === '--once') options.once = true;
    else if (arg === '--interval') options.interval = Number(rest[++i]);
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
    const filePath = manifest.databaseDump.path.startsWith('/') ? manifest.databaseDump.path : path.join(baseDir, manifest.databaseDump.path);
    checks.push({
      id: 'databaseDump.exists',
      ok: await exists(manifest.databaseDump.path, baseDir),
      message: 'Database dump exists on disk.',
    });
    // 15th-audit: "Verified" must mean VERIFIED — the old check only
    // confirmed the file existed and the manifest hash *looked* like a
    // SHA-256. Now the actual bytes are hashed and compared.
    try {
      // 16th-audit: STREAMING hash — the old readFile() pulled the
      // entire dump (potentially 10-50 GB) into memory. createReadStream
      // + incremental hash keeps memory flat regardless of dump size.
      const { createReadStream } = await import('node:fs');
      const stat = await fs.stat(filePath);
      const hash = createHash('sha256');
      await new Promise((resolveHash, rejectHash) => {
        const stream = createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', resolveHash);
        stream.on('error', rejectHash);
      });
      const actual = hash.digest('hex');
      checks.push({
        id: 'databaseDump.sha256Match',
        ok: actual === manifest.databaseDump.sha256.toLowerCase(),
        message: `Actual SHA-256 matches manifest (${actual.slice(0, 16)}…).`,
      });
      checks.push({
        id: 'databaseDump.sizeMatch',
        ok: stat.size === manifest.databaseDump.sizeBytes,
        message: `Actual size matches manifest (${stat.size} bytes).`,
      });
    } catch (err) {
      checks.push({
        id: 'databaseDump.sha256Match',
        ok: false,
        message: `Could not read dump for hash verification: ${err.message}`,
      });
    }
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
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    // 21st-audit: pre-release identifiers decide ordering —
    // 0.2.0-rc.1 < 0.2.0-rc.2 < 0.2.0 (semver §11). The old parser
    // matched but then DROPPED the suffix, making all three "equal".
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a release outranks any of its pre-releases
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1; // fewer identifiers = LOWER precedence
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const delta = Number.parseInt(x, 10) - Number.parseInt(y, 10);
      if (delta !== 0) return delta < 0 ? -1 : 1;
    } else if (xNumeric) return -1; // numeric identifiers sort below alphanumeric
    else if (yNumeric) return 1;
    else if (x !== y) return x < y ? -1 : 1; // ASCII lexical order
  }
  return 0;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] > right[key]) return 1;
    if (left[key] < right[key]) return -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

async function loadManifest(source) {
  if (!source) {
    // 21st-audit: the documented `check → plan → apply` chain passes NO
    // --manifest on the 2nd/3rd command — default to the official latest
    // release asset instead of erroring out.
    source = process.env.LOBBYFORGE_RELEASE_MANIFEST ?? DEFAULT_MANIFEST_URL;
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
  // 21st-audit: when present, the digest binding must be well-formed —
  // it is what apply deploys, byte-exact.
  if (manifest.gitSha !== undefined && !/^[0-9a-f]{40}$/i.test(manifest.gitSha)) {
    throw new Error('Manifest gitSha must be a 40-hex commit SHA.');
  }
  if (manifest.imageDigest !== undefined && !/^[\w.\-/]+@sha256:[a-f0-9]{64}$/i.test(manifest.imageDigest)) {
    throw new Error('Manifest imageDigest must be <image-ref>@sha256:<64hex>.');
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
  const envPem = process.env.LOBBYFORGE_RELEASE_PUBLIC_KEY_PEM;
  if (envPem) return envPem;
  // 21st-audit: the official public key is committed in the repo — pin it
  // by DEFAULT so unsigned/tampered manifests fail closed out of the box.
  // Forks override with --public-key / LOBBYFORGE_RELEASE_PUBLIC_KEY_PEM.
  try {
    return await fs.readFile(path.resolve(process.cwd(), DEFAULT_PUBLIC_KEY_PATH), 'utf8');
  } catch {
    return null;
  }
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

// ── Deployed-state helpers (21st-audit) ──────────────────────────────
// The updater must know what is ACTUALLY deployed: the current version
// is read from the environment / .env.prod / deployment-state.json —
// never hardcoded — and every successful apply persists the new state
// so rollback has a real previous pointer.

async function readEnvProdValue(key) {
  try {
    const raw = await fs.readFile(path.resolve(process.cwd(), ENV_FILE), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = new RegExp(`^\\s*${key}=(.*)$`).exec(line);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    return null;
  }
  return null;
}

async function setEnvProdValue(key, value) {
  const file = path.resolve(process.cwd(), ENV_FILE);
  let raw = '';
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    // first write creates the file
  }
  const re = new RegExp(`^\\s*${key}=.*$`);
  let replaced = false;
  const out = raw
    .split(/\r?\n/)
    .map((line) => {
      if (!replaced && re.test(line)) {
        replaced = true;
        return `${key}=${value}`;
      }
      return line;
    });
  if (!replaced) out.push(`${key}=${value}`);
  await fs.writeFile(file, `${out.join('\n').replace(/^\n+/, '').replace(/\n+$/, '')}\n`);
}

async function readDeploymentState() {
  try {
    return JSON.parse(await fs.readFile(path.resolve(process.cwd(), STATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

async function writeDeploymentState(state) {
  const file = path.resolve(process.cwd(), STATE_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ ...state, updatedAt: state.updatedAt ?? new Date().toISOString() }, null, 2)}\n`);
}

async function resolveCurrentVersion(options) {
  if (options.currentVersion) return options.currentVersion; // explicit --current-version
  if (process.env.LOBBYFORGE_VERSION) return process.env.LOBBYFORGE_VERSION;
  const fromEnvFile = await readEnvProdValue('LOBBYFORGE_VERSION');
  if (fromEnvFile) return fromEnvFile;
  const state = await readDeploymentState();
  if (state && typeof state.version === 'string') return state.version;
  // 22nd-audit: silently assuming a version is how an updater lies about
  // what it will do — refuse instead of guessing.
  throw new Error(
    'Cannot determine the currently deployed version: no --current-version, LOBBYFORGE_VERSION,\n' +
    '.env.prod entry or deployment-state.json found. On an installed server run install.sh\n' +
    'first; on a bare checkout pass --current-version explicitly.'
  );
}

async function resolveDatabaseUrl() {
  return process.env.DATABASE_URL ?? (await readEnvProdValue('DATABASE_URL'));
}

const COMPOSE_BASE_ARGS = ['compose', '-f', COMPOSE_FILE, '--env-file', ENV_FILE];
const HEALTH_PROBE_SCRIPT =
  "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})";

async function composeExec(args, timeoutMs = 300_000) {
  const { stdout, stderr } = await execFileAsync(DOCKER_PREFIX[0], dockerArgs([...COMPOSE_BASE_ARGS, ...args]), { timeout: timeoutMs });
  return { stdout, stderr };
}

async function composeHealthCheck() {
  await composeExec(['exec', '-T', 'web', 'node', '-e', HEALTH_PROBE_SCRIPT], 60_000);
}

// 21st-audit: rollback is REAL now — it restores the previously recorded
// image ref + version, recreates services on it and health-checks. DB
// migrations are forward-only (drizzle journals have no down); the
// previous app image runs against the current schema. Releases with
// breaking migrations must be recovered via `lfctl backup restore`.
async function updateRollback(options = {}) {
  const state = await readDeploymentState();
  if (!state || !state.previous || !state.previous.image) {
    console.error(`No previous deployment recorded in ${STATE_FILE} — nothing to roll back to.`);
    console.error(
      `If an update failed midway, .env.prod already kept/restored the old image ref;\n` +
      `recreate the stack with:\n  docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} up -d --remove-orphans --wait`
    );
    process.exitCode = 2;
    return;
  }
  const target = state.previous;
  console.log(`Rolling back ${state.version} -> ${target.version} (image ${target.image})`);
  console.log(
    'NOTE: database migrations are forward-only — the previous image runs against the\n' +
    'current schema. If the failed release shipped breaking migrations, restore the\n' +
    'pre-update backup instead: lfctl backup restore --file <dump> --to <empty-database-url>'
  );
  await setEnvProdValue('LOBBYFORGE_IMAGE', target.image);
  await setEnvProdValue('LOBBYFORGE_VERSION', target.version);
  try {
    await composeExec(['up', '-d', '--remove-orphans', '--wait'], 600_000);
    await composeHealthCheck();
  } catch (err) {
    console.error(`Rollback FAILED: ${err.stderr || err.message}`);
    process.exitCode = 2;
    return;
  }
  await writeDeploymentState({
    version: target.version,
    image: target.image,
    gitSha: null,
    previous: null, // pointer consumed — a second rollback is refused
    rolledBackFrom: state.version,
  });
  console.log(`Rollback complete — running ${target.version}.`);
}

async function buildPlan(manifest, options) {
  const check = await buildCheck(manifest, options);
  const commands = manifest.commands && typeof manifest.commands === 'object' ? manifest.commands : {};
  const migrations = manifest.migrations && typeof manifest.migrations === 'object' ? manifest.migrations : {};

  // 21st-audit: the pull step is DIGEST-driven when the manifest pins
  // one — apply deploys the exact signed bytes, not a mutable tag.
  const digest = typeof manifest.imageDigest === 'string' ? manifest.imageDigest : null;
  const steps = [
    {
      id: 'preflight-doctor',
      title: 'Run Doctor preflight (current stack health)',
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
      title: digest ? `Pull signed image digest (${digest})` : 'Pull new Docker images',
      required: true,
      command: digest
        ? `docker compose pull web ws-gateway plugin-worker migrate  # ${digest}`
        : command(commands.composePull, 'docker compose build --pull'),
    },
    {
      id: 'migration-dry-run',
      title: 'Review migration plan (informational — drizzle journals are forward-only)',
      required: false,
      command: command(migrations.dryRunCommand, 'inspect packages/db/drizzle/ migrations between versions'),
    },
    {
      id: 'apply-migrations',
      title: 'Apply database migrations',
      required: true,
      command: command(migrations.applyCommand, 'docker compose run --rm migrate'),
    },
    {
      id: 'recreate-services',
      title: 'Recreate services',
      required: true,
      command: command(commands.composeUp, 'docker compose up -d --remove-orphans --wait'),
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
    targetImage: digest,
    gitSha: typeof manifest.gitSha === 'string' ? manifest.gitSha : null,
    safeToAutoApply: false,
    requiresAdminConfirmation: true,
    requiresExtraMajorConfirmation: check.majorUpgrade,
    rollbackCommand: command(commands.rollback, 'node scripts/lfctl.mjs update rollback'),
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
  if (check.targetImage) console.log(`Target image: ${check.targetImage}`);
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
  console.log('Auto-apply: gated on --yes + strictly verified backup (safety gates enforced).');
}

// ── Directory heartbeat signing (LF-SEC-007) ─────────────────────────
// Self-contained twin of apps/web/lib/directory-heartbeat.ts (lfctl runs
// from a plain checkout with no build step). The canonical payload must
// stay byte-identical to the SERVER verifier — fixed key order, undefined
// stats keys omitted. Both sides are pinned by tests.
function sanitizeHeartbeatStats(stats) {
  const clean = {};
  if (stats.onlineUsers !== undefined) clean.onlineUsers = stats.onlineUsers;
  if (stats.publicRoomsCount !== undefined) clean.publicRoomsCount = stats.publicRoomsCount;
  if (stats.version !== undefined) clean.version = stats.version;
  if (stats.doctorScore !== undefined) clean.doctorScore = stats.doctorScore;
  return clean;
}

function buildSignedHeartbeat({ instanceId, stats, privateKeyPem }) {
  const base = {
    instanceId,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: randomBytes(24).toString('base64url'),
    stats: sanitizeHeartbeatStats(stats),
  };
  const canonical = JSON.stringify(base);
  const signature = sign(null, Buffer.from(canonical, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64');
  return { ...base, signature };
}

async function sendDirectoryHeartbeat({ directoryOrigin, signed }) {
  let res;
  try {
    res = await fetch(`${directoryOrigin.replace(/\/$/, '')}/api/directory/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed),
    });
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
  if (res.ok) return { ok: true, status: res.status };
  const detail = await res.json().catch(() => ({}));
  return { ok: false, status: res.status, error: detail.error ?? `HTTP ${res.status}` };
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
      const out = await backupRestore(options.file, options['to'], options);
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

  if (domain === 'directory') {
    if (action === 'keygen') {
      const outDir = options.out ?? 'infra/keys';
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      await fs.mkdir(outDir, { recursive: true });
      const privPath = path.join(outDir, 'instance-ed25519-private.pem');
      const pubPath = path.join(outDir, 'instance-ed25519-public.pem');
      await fs.writeFile(privPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
      await fs.writeFile(pubPath, publicKey.export({ format: 'pem', type: 'spki' }));
      const spkiB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      if (options.json) {
        console.log(JSON.stringify({ privateKeyPath: privPath, publicKeyPath: pubPath, publicKeyBase64: spkiB64 }, null, 2));
      } else {
        console.log(`Private key: ${privPath} (mode 600 — do not commit)`);
        console.log(`Public key:  ${pubPath}`);
        console.log('\npublicKey (base64 SPKI) to submit at registration:');
        console.log(spkiB64);
      }
      return;
    }
    if (action === 'proof') {
      if (!options.instanceId) throw new Error('directory proof requires --instance-id <id>');
      if (!options.url) throw new Error('directory proof requires --url <domain>');
      if (!options.keyFile) throw new Error('directory proof requires --key-file <pem>');
      const privateKeyPem = await fs.readFile(options.keyFile, 'utf8');
      const publicKeyPem = await fs.readFile(options.keyFile.replace('private', 'public'), 'utf8');
      const publicKeyB64 = createPublicKey(publicKeyPem)
        .export({ format: 'der', type: 'spki' })
        .toString('base64');
      const canonical = JSON.stringify({
        verify: 1,
        instanceId: options.instanceId,
        domain: options.url,
        publicKey: publicKeyB64,
      });
      const proof = sign(null, Buffer.from(canonical, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64');
      if (options.json) {
        console.log(JSON.stringify({ proof, instanceId: options.instanceId, domain: options.url }, null, 2));
      } else {
        console.log('Directory verification proof:');
        console.log(proof);
        console.log('\nStore this proof on your instance (admin→ directory settings).');
        console.log('The /.well-known/lobbyforge-verification endpoint will serve it.');
      }
      return;
    }

    if (action === 'heartbeat') {
      if (!options.url) throw new Error('directory heartbeat requires --url <directory-origin>');
      if (!options.instanceId) throw new Error('directory heartbeat requires --instance-id <id>');
      if (!options.keyFile) throw new Error('directory heartbeat requires --key-file <pem>');
      const privateKeyPem = await fs.readFile(options.keyFile, 'utf8');
      const stats = {};
      if (options.onlineUsers !== undefined) stats.onlineUsers = options.onlineUsers;
      if (options.publicRooms !== undefined) stats.publicRoomsCount = options.publicRooms;
      if (options.statsVersion !== undefined) stats.version = options.statsVersion;
      if (options.doctorScore !== undefined) stats.doctorScore = options.doctorScore;

      const sendOnce = async () => {
        const signed = buildSignedHeartbeat({
          instanceId: options.instanceId,
          stats,
          privateKeyPem,
        });
        const result = await sendDirectoryHeartbeat({ directoryOrigin: options.url, signed });
        if (options.json) console.log(JSON.stringify(result));
        else console.log(`[${new Date().toISOString()}] heartbeat ${result.ok ? 'ok' : `FAILED (${result.status}${result.error ? `: ${result.error}` : ''})`}`);
        if (!result.ok) process.exitCode = 2;
        return result.ok;
      };

      if (options.once || !options.interval) {
        await sendOnce();
        return;
      }
      // Loop mode — the nonce is fresh per send, so replays never trip.
      const intervalMs = Math.max(60, options.interval) * 1000;
      console.error(`Sending signed heartbeats every ${intervalMs / 1000}s — Ctrl-C to stop.`);
      await sendOnce();
      setInterval(() => { void sendOnce(); }, intervalMs);
      return;
    }
    throw new Error(`Unknown directory action: ${action ?? '(missing)'}`);
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
    await updateRollback(options);
    return;
  }

  if (!['check', 'plan', 'apply'].includes(action)) {
    throw new Error(`Unknown update action: ${action ?? '(missing)'}`);
  }

  // 21st-audit: the deployed version comes from the machine's own state
  // (.env.prod / deployment-state.json), not a hardcoded constant.
  options.currentVersion = await resolveCurrentVersion(options);
  const manifest = await loadManifest(options.manifest);
  if (action === 'check') {
    const check = await buildCheck(manifest, options);
    if (options.json) console.log(JSON.stringify(check, null, 2));
    else printCheck(check);
    // 21st-audit: with a pinned key (default: the committed official
    // public key) an unsigned/tampered manifest fails CLOSED even for the
    // informational command — scripts gating on `update check` stay safe.
    if (check.signature.required && !check.signature.verified) {
      console.error(`\nManifest signature ${check.signature.status.toUpperCase()} — refusing to trust this release source.`);
      process.exitCode = 2;
    }
    return;
  }

  const plan = await buildPlan(manifest, options);
  if (action === 'plan') {
    if (options.json) console.log(JSON.stringify(plan, null, 2));
    else printPlan(plan);
    return;
  }
  printPlan(plan);

  // 20th-audit: enforce safety gates BEFORE touching anything.
  // buildPlan() already flattens check fields into the plan object.
  if (!plan.updateAvailable) {
    console.error('\nNo update available (current >= target).');
    process.exitCode = 0;
    return;
  }
  if (!plan.currentSupported) {
    console.error('\nCurrent version is below the manifest minimumVersion — manual migration required.');
    process.exitCode = 2;
    return;
  }
  // Signature: the verifier returns { status, verified, required }.
  // Fail-closed only when a key IS configured and verification FAILED.
  if (plan.signature && plan.signature.required && !plan.signature.verified) {
    console.error('\nManifest signature INVALID — refusing to update from an untrusted source.');
    process.exitCode = 2;
    return;
  }
  if (plan.majorUpgrade && !options.forceMajor) {
    console.error('\nThis is a MAJOR upgrade. Re-run with --force-major to confirm.');
    process.exitCode = 2;
    return;
  }
  // 22nd-audit: a manifest verified against a pinned key MUST pin the
  // deployed bytes — the signature → exact-image-digest binding IS the
  // point of the signed-manifest system. The warned local-build path
  // remains only for unsigned manifests (no key configured).
  if (plan.signature.verified && !manifest.imageDigest) {
    console.error('\nVerified manifest has no imageDigest — refusing to apply.');
    console.error('A signature must vouch for the exact deployed bytes; a version number alone is not deployable trust.');
    process.exitCode = 2;
    return;
  }

  // 21st-audit: apply must never depend on a hand-written backup manifest.
  // With --backup-manifest it verifies THAT dump; without it, a FRESH
  // backup is created right here (database URL resolved from the
  // environment / .env.prod, pg tools inside the compose postgres when
  // the URL is compose-internal) and strictly verified.
  let backupManifestPath = options.backupManifest;
  if (!backupManifestPath) {
    console.log('\nNo --backup-manifest given — creating a fresh backup...');
    const dbUrl = await resolveDatabaseUrl();
    if (!dbUrl) {
      console.error('Cannot auto-backup: no DATABASE_URL in env or .env.prod. Pass --database-url or --backup-manifest.');
      process.exitCode = 2;
      return;
    }
    const created = await backupCreate({ 'database-url': dbUrl });
    console.log(`Backup created: ${created.file} (sha256 ${created.sha256.slice(0, 16)}…)`);
    backupManifestPath = created.manifestPath;
  }
  const { manifest: backupManifest, baseDir } = await loadBackupManifest(backupManifestPath);
  // 19th-audit: STRICT backup verification — requireFiles is MANDATORY
  // for destructive operations, not opt-in.
  const backup = await verifyBackup(backupManifest, baseDir, { ...options, requireFiles: true });
  printBackup(backup);

  if (!backup.ok) {
    console.error('\nUpdate ABORTED: backup verification failed.');
    process.exitCode = 2;
    return;
  }
  if (!options.yes) {
    console.error('\nUpdate plan ready. Re-run with --yes to execute.');
    process.exitCode = 0;
    return;
  }

  // 21st-audit: capture the previous deployment for rollback BEFORE
  // mutating anything.
  let previousImage = (await readEnvProdValue('LOBBYFORGE_IMAGE')) ?? 'lobbyforge-web:latest';
  const previousVersion = options.currentVersion;
  const usesDigest = typeof manifest.imageDigest === 'string' && manifest.imageDigest.length > 0;
  let envImageMutated = false;
  // 23rd-audit: `compose up` is NOT atomic — it can create the NEW
  // containers and still exit non-zero when a healthcheck fails. The
  // flag is therefore set BEFORE the command ("may have changed"), so
  // the failure handler always attempts container recovery.
  let servicesMayHaveChanged = false;

  // 22nd-audit: the FIRST update's rollback target is a MUTABLE local
  // tag (lobbyforge-web:latest) — a later build could silently replace
  // those bytes. Pin the currently-running image to a timestamped
  // rollback tag so the pointer stays byte-exact even if `latest` moves.
  // 23rd-audit: fail-CLOSED — without a byte-exact anchor the first
  // digest transition has no guaranteed rollback, so abort instead of
  // promising a rollback we cannot deliver.
  if (!/@sha256:[a-f0-9]{64}$/i.test(previousImage)) {
      const rollbackTag = `lobbyforge-web:rollback-${Date.now()}`;
    try {
      await execFileAsync(DOCKER_PREFIX[0], dockerArgs(['tag', previousImage, rollbackTag]), { timeout: 60_000 });
      console.log(`Rollback anchor: ${previousImage} -> ${rollbackTag} (byte-exact rollback target)`);
      previousImage = rollbackTag;
    } catch (err) {
      console.error(`Cannot pin a rollback anchor for ${previousImage} (${err.message}).`);
      console.error('A mutable rollback target cannot guarantee recovery from the first digest update — aborting.');
      process.exitCode = 2;
      return;
    }
  }

  console.log('\nExecuting update plan...\n');
  for (const step of plan.steps) {
    const label = step.title || step.id;
    process.stdout.write(`  ${step.id}: ${label}... `);
    try {
      if (step.id === 'preflight-doctor') {
        // The CURRENT stack must be healthy before we touch it — an
        // update that starts from a broken deployment has no baseline.
        await composeHealthCheck();
        console.log('ok (current stack healthy)');
      } else if (step.id === 'backup') {
        console.log('ok (verified above)');
      } else if (step.id === 'pull-images') {
        if (usesDigest) {
          // Digest model: the signed manifest pins the exact image bytes.
          // Point compose at the digest, then pull the four app services.
          await setEnvProdValue('LOBBYFORGE_IMAGE', manifest.imageDigest);
          envImageMutated = true;
          await composeExec(['pull', 'web', 'ws-gateway', 'plugin-worker', 'migrate'], 600_000);
          console.log('ok (pulled signed digest)');
        } else {
          // Legacy manifest without a digest binding: build the current
          // checkout. The signature does NOT vouch for these bytes.
          console.log('\n    WARNING: manifest has no imageDigest — building the LOCAL checkout.');
          console.log('    The signed manifest does not vouch for locally-built bytes.');
          await composeExec(['build', '--pull'], 1_800_000);
          console.log('    built (unsigned deployment path)');
        }
      } else if (step.id === 'migration-dry-run') {
        console.log('informational (drizzle migrations are forward-only)');
      } else if (step.id === 'apply-migrations') {
        // Run the NEW image's migrator before recreating services.
        await composeExec(['run', '--rm', 'migrate'], 900_000);
        console.log('ok');
      } else if (step.id === 'recreate-services') {
        // Set BEFORE the command: a non-zero exit does NOT mean nothing
        // changed — containers may be running the broken new image.
        servicesMayHaveChanged = true;
        await composeExec(['up', '-d', '--remove-orphans', '--wait'], 900_000);
        console.log('ok');
      } else if (step.id === 'health-check') {
        await composeHealthCheck();
        console.log('ok');
      } else if (step.required) {
        // 21st-audit: a required step without an executor ABORTS the
        // update — "skipped" followed by "completed successfully" was
        // dishonest runner semantics.
        throw new Error(`no executor implemented for required step "${step.id}"`);
      } else {
        console.log('informational');
      }
    } catch (err) {
      console.log('FAILED');
      console.error(`    ${err.stderr || err.message}`);
      // Restore the recorded image ref first so compose targets the old
      // bytes again on the next `up`.
      if (envImageMutated) {
        await setEnvProdValue('LOBBYFORGE_IMAGE', previousImage).catch(() => {});
      }
      // 22nd-audit: if the new containers were already created, a bare
      // env restore is NOT recovery — the broken image keeps running
      // while .env.prod claims otherwise. Bring the stack back up on the
      // restored ref and health-check it for real.
      let recovery = 'old containers untouched (failure happened before recreate)';
      if (servicesMayHaveChanged) {
        try {
          await composeExec(['up', '-d', '--remove-orphans', '--wait'], 900_000);
          await composeHealthCheck();
          recovery = 'OLD CONTAINERS RESTORED AND HEALTHY';
        } catch (recErr) {
          recovery = 'MANUAL ROLLBACK REQUIRED';
          console.error(`    auto-recovery failed: ${recErr.stderr || recErr.message}`);
          // 22nd-audit: keep a WORKING rollback pointer — writing
          // previous:null here is what made `update rollback` refuse to
          // help exactly when it was needed most.
          await writeDeploymentState({
            version: previousVersion,
            image: previousImage,
            gitSha: null,
            previous: { version: previousVersion, image: previousImage },
            note: `update to ${plan.latestVersion} failed after recreate; auto-recovery failed — run "lfctl update rollback"`,
          });
        }
      }
      if (recovery !== 'MANUAL ROLLBACK REQUIRED') {
        await writeDeploymentState({
          version: previousVersion,
          image: previousImage,
          gitSha: null,
          previous: null,
          note: `update to ${plan.latestVersion} failed at step "${step.id}" (${recovery}); .env.prod image ref restored`,
        });
      }
      console.error(`\nUpdate step "${step.id}" failed. Recovery: ${recovery}`);
      console.error(`.env.prod image ref restored to ${previousImage}.`);
      if (recovery === 'MANUAL ROLLBACK REQUIRED') {
        console.error(`Run: node scripts/lfctl.mjs update rollback`);
      }
      process.exitCode = 2;
      return;
    }
  }

  // 21st-audit: persist what is now deployed — future check/plan/apply
  // invocations read this instead of assuming a hardcoded version.
  await setEnvProdValue('LOBBYFORGE_VERSION', plan.latestVersion);
  await writeDeploymentState({
    version: plan.latestVersion,
    image: usesDigest ? manifest.imageDigest : previousImage,
    gitSha: plan.gitSha,
    previous: { version: previousVersion, image: previousImage },
  });
  console.log(`\nUpdate completed successfully — deployed ${plan.latestVersion}`);
  console.log(`Version state persisted (${ENV_FILE} + ${STATE_FILE}).`);
  console.log('Rollback if needed:', plan.rollbackCommand);
}


main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

// ── Backup create / restore ──────────────────────────────────────────
// Real pg_dump-based backup with SHA-256 checksum, and restore into an
// empty database.
//
// pg_dump/pg_restore/psql resolution: by default they must be on PATH.
// Set LFCTL_PG_CONTAINER=<container> to run them via `docker exec`
// INSIDE the PostgreSQL container instead — operators don't need a host
// pg installation (the container always ships the exact-version tools).
// (PG_CONTAINER + execFileAsync live at the TOP of this file — see the
// TDZ note there.)

// 21st-audit: install.sh writes a compose-internal DATABASE_URL
// (host "postgres") — unreachable from the host. When no container is
// configured explicitly, resolve the compose postgres container so the
// auto-backup in `update apply` works with zero operator config.
async function ensurePgContainer(dbUrl = null) {
  if (PG_CONTAINER) return PG_CONTAINER;
  const url = dbUrl ?? (await resolveDatabaseUrl());
  if (url && !/@(localhost|127\.0\.0\.1|\[::1\])/.test(url.split('?')[0])) {
    try {
      const { stdout } = await execFileAsync(
        DOCKER_PREFIX[0],
        dockerArgs([...COMPOSE_BASE_ARGS, 'ps', '-q', 'postgres']),
        { timeout: 60_000 }
      );
      const id = stdout.trim();
      if (id) PG_CONTAINER = id;
    } catch {
      // compose not reachable — fall through to host tools on PATH
    }
  }
  return PG_CONTAINER;
}

async function pgExec(tool, args, options = {}) {
  if (PG_CONTAINER) {
    return execFileAsync(DOCKER_PREFIX[0], dockerArgs(['exec', PG_CONTAINER, tool, ...args]), options);
  }
  return execFileAsync(tool, args, options);
}

// 20th-audit: container mode used to buffer the ENTIRE -Fc dump in RAM
// (maxBuffer up to 1 GiB) before writing it out. Spawn docker exec and
// pipe stdout straight to disk — memory stays flat for any dump size,
// and any failure deletes the partial file so it can never masquerade
// as a restorable backup.
function streamPgDumpTo(dbUrl, outFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER_PREFIX[0], dockerArgs(['exec', PG_CONTAINER, 'pg_dump', '-Fc', dbUrl]), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = createWriteStream(outFile);
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.end(() => {
        if (err) {
          fs.unlink(outFile).catch(() => {});
          reject(err);
        } else {
          resolve();
        }
      });
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`pg_dump timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.pipe(out);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', finish);
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`pg_dump exited with code ${code}: ${stderr.trim().slice(0, 400)}`));
    });
  });
}

async function backupCreate(options = {}) {
  const outDir = options.out ?? 'backups';
  const dbUrl = options['database-url'] ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('backup create requires --database-url or DATABASE_URL');
  await ensurePgContainer(dbUrl);

  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `lobbyforge-${stamp}.dump`);

  // pg_dump custom format (-Fc) — compressed, supports parallel restore + selective tables.
  if (PG_CONTAINER) {
    // Container mode: the container cannot see the host output directory,
    // so docker-exec stdout is piped straight into the host-side file
    // (binary bytes, no decode step, no RAM buffer).
    await streamPgDumpTo(dbUrl, file, 300_000);
  } else {
    await pgExec('pg_dump', ['-Fc', '-f', file, dbUrl], { timeout: 300_000 });
  }

  // 18th-audit: streaming hash — multi-GB dumps stay flat-memory.
  const { createReadStream } = await import('node:fs');
  const stat = await fs.stat(file);
  const hash = createHash('sha256');
  await new Promise((resolveH, rejectH) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolveH);
    stream.on('error', rejectH);
  });
  const sha256 = hash.digest('hex');
  const buf = { byteLength: stat.size }; // size-only shim (no full read)

  // 19th-audit: emit the CANONICAL formatVersion:1 manifest — the
  // same shape `lfctl update apply --backup-manifest` and `lfctl
  // backup verify` consume, so `backup create` output feeds directly
  // into the update flow without format conversion.
  const backupId = `backup-${Date.now()}`;
  const manifest = {
    formatVersion: 1,
    backupId,
    completed: true,
    createdAt: new Date().toISOString(),
    databaseDump: {
      path: path.basename(file),
      sha256,
      sizeBytes: buf.byteLength ?? buf.length,
    },
    includes: { database: true },
  };
  await fs.writeFile(`${file}.manifest.json`, JSON.stringify(manifest, null, 2));
  // Legacy sidecar for `backup restore` (reads sha256 from `${file}.json`).
  const meta = {
    file: path.basename(file),
    sha256,
    sizeBytes: buf.byteLength ?? buf.length,
    createdAt: new Date().toISOString(),
    databaseUrlPrefix: dbUrl.split('@').pop()?.split('/')[0] ?? 'unknown-host',
  };
  await fs.writeFile(`${file}.json`, JSON.stringify(meta, null, 2));

  return { file, sha256, sizeBytes: buf.byteLength ?? buf.length, manifestPath: `${file}.manifest.json`, backupId };
}

async function backupRestore(file, targetUrl, options = {}) {
  try {
    // V5-004: checksum verification is FAIL-CLOSED. A missing or
    // malformed sidecar, or a digest mismatch, refuses the restore —
    // restoring a silently-corrupted dump over a destroyed database is
    // the worst outcome this tool can produce. --allow-unverified is the
    // explicit operator escape hatch (e.g. restoring a dump whose
    // sidecar was lost).
    const allowUnverified = options['allow-unverified'] === true;
    let sidecar = null;
    try {
      sidecar = JSON.parse(await fs.readFile(`${file}.json`, 'utf8'));
      if (!sidecar || typeof sidecar.sha256 !== 'string' || sidecar.sha256.length !== 64) {
        sidecar = null;
      }
    } catch {
      sidecar = null;
    }
    if (!sidecar) {
      if (!allowUnverified) {
        return {
          ok: false,
          message:
            'Checksum sidecar missing or malformed — refusing to restore. ' +
            'Pass --allow-unverified to restore anyway (last resort).',
        };
      }
    } else {
      const { createReadStream: crs } = await import('node:fs');
      const h = createHash('sha256');
      await new Promise((resolveH, rejectH) => {
        const st = crs(file);
        st.on('data', (c) => h.update(c));
        st.on('end', resolveH);
        st.on('error', rejectH);
      });
      const actual = h.digest('hex');
      if (actual !== sidecar.sha256) {
        return { ok: false, message: 'SHA-256 mismatch — dump may be corrupted.' };
      }
    }

    // Safety: refuse to restore into a database that already has tables.
    // Count EVERY non-system schema — checking only `public` let a
    // populated `drizzle` (migrations ledger) schema slip through and
    // collide mid-restore.
    const { stdout } = await pgExec('psql', [targetUrl, '-tAc',
      "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')"], { timeout: 30_000 });
    if (parseInt(stdout.trim(), 10) > 0) {
      return { ok: false, message: 'Target database is not empty. Restore requires an empty database.' };
    }

    if (PG_CONTAINER) {
      // Container mode: the dump lives on the host — copy it in, restore,
      // remove it again.
      const inContainer = '/tmp/lfctl-restore.dump';
      await execFileAsync(DOCKER_PREFIX[0], dockerArgs(['cp', file, `${PG_CONTAINER}:${inContainer}`]), { timeout: 120_000 });
      try {
        await pgExec('pg_restore', ['--no-owner', '--no-privileges', '-d', targetUrl, inContainer], { timeout: 600_000 });
      } finally {
        await execFileAsync(DOCKER_PREFIX[0], dockerArgs(['exec', PG_CONTAINER, 'rm', '-f', inContainer]), { timeout: 30_000 }).catch(() => {});
      }
    } else {
      await pgExec('pg_restore', ['--no-owner', '--no-privileges', '-d', targetUrl, file], { timeout: 600_000 });
    }
    return { ok: true, message: 'Database restored successfully.' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
