import fs from 'node:fs/promises';
import { verify as verifySignature } from 'node:crypto';
import path from 'node:path';

export type UpdateChannel = 'stable' | 'beta' | 'nightly' | string;

export interface ReleaseManifest {
  channel?: UpdateChannel;
  version: string;
  signature?: string;
  keyId?: string;
  minimumVersion?: string;
  releaseNotes?: string;
  breakingChanges?: string[];
  commands?: Record<string, string>;
  migrations?: {
    dryRunCommand?: string;
    applyCommand?: string;
  };
}

export interface UpdateCheck {
  channel: UpdateChannel;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  majorUpgrade: boolean;
  currentSupported: boolean;
  releaseNotes: string;
  breakingChanges: string[];
  signature: ManifestSignatureStatus;
}

export interface UpdatePlan extends UpdateCheck {
  safeToAutoApply: false;
  requiresAdminConfirmation: true;
  requiresExtraMajorConfirmation: boolean;
  rollbackCommand: string;
  steps: {
    id: string;
    title: string;
    required: true;
    command: string;
  }[];
}

const DEFAULT_CHANNEL = 'stable';
const DEFAULT_CURRENT_VERSION = '0.1.0';
const DEFAULT_MANIFEST_PATH = 'infra/update/release-manifest.example.json';
const MAX_REMOTE_MANIFEST_BYTES = 1024 * 1024;
const MANIFEST_FETCH_TIMEOUT_MS = 10_000;
const MANIFEST_KEYS = new Set([
  'channel', 'version', 'signature', 'keyId', 'minimumVersion', 'releaseNotes',
  'breakingChanges', 'commands', 'migrations',
]);
const COMMAND_KEYS = new Set(['doctor', 'backup', 'composePull', 'composeUp', 'healthCheck', 'rollback']);
const MIGRATION_KEYS = new Set(['dryRunCommand', 'applyCommand']);

export type ManifestSignatureStatus =
  | { status: 'not_configured'; verified: false; required: false }
  | { status: 'missing'; verified: false; required: true }
  | { status: 'invalid'; verified: false; required: true; keyId?: string }
  | { status: 'valid'; verified: true; required: true; keyId?: string };

function parseVersion(version: string): { major: number; minor: number; patch: number } {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] > right[key]) return 1;
    if (left[key] < right[key]) return -1;
  }
  return 0;
}

export function validateManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Manifest must be an object.');
  const manifest = value as ReleaseManifest;
  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.has(key)) throw new Error(`Unknown manifest field: ${key}`);
  }
  if (typeof manifest.version !== 'string' || manifest.version.length > 64) {
    throw new Error('Manifest version is required.');
  }
  parseVersion(manifest.version);
  if (manifest.channel !== undefined && (typeof manifest.channel !== 'string' || manifest.channel.length > 32)) {
    throw new Error('Manifest channel must be a string.');
  }
  if (manifest.releaseNotes !== undefined && (typeof manifest.releaseNotes !== 'string' || manifest.releaseNotes.length > 50_000)) {
    throw new Error('Manifest releaseNotes must be a string.');
  }
  if (manifest.minimumVersion !== undefined && (typeof manifest.minimumVersion !== 'string' || manifest.minimumVersion.length > 64)) {
    throw new Error('Manifest minimumVersion must be a string.');
  }
  if (manifest.minimumVersion) parseVersion(manifest.minimumVersion);
  if (manifest.signature !== undefined && (
    typeof manifest.signature !== 'string' ||
    manifest.signature.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(manifest.signature)
  )) {
    throw new Error('Manifest signature must be a string.');
  }
  if (manifest.keyId !== undefined && (typeof manifest.keyId !== 'string' || manifest.keyId.length > 128)) {
    throw new Error('Manifest keyId must be a string.');
  }
  if (manifest.breakingChanges !== undefined && (
    !Array.isArray(manifest.breakingChanges) ||
    manifest.breakingChanges.length > 100 ||
    !manifest.breakingChanges.every((item) => typeof item === 'string' && item.length <= 1000)
  )) {
    throw new Error('Manifest breakingChanges must be an array.');
  }
  validateStringMap(manifest.commands, COMMAND_KEYS, 'commands');
  validateStringMap(manifest.migrations, MIGRATION_KEYS, 'migrations');
  return manifest;
}

function validateStringMap(value: unknown, allowedKeys: Set<string>, label: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Manifest ${label} must be an object.`);
  }
  for (const [key, commandValue] of Object.entries(value)) {
    if (!allowedKeys.has(key)) throw new Error(`Unknown manifest ${label} field: ${key}`);
    if (typeof commandValue !== 'string' || commandValue.length === 0 || commandValue.length > 500) {
      throw new Error(`Manifest ${label}.${key} must be a bounded string.`);
    }
  }
}

export function canonicalizeReleaseManifest(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeReleaseManifest(item)).join(',')}]`;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).filter((key) => key !== 'signature').sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeReleaseManifest(input[key])}`).join(',')}}`;
}

function base64urlToBuffer(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

export function verifyReleaseManifestSignature(
  manifest: ReleaseManifest,
  publicKeyPem = process.env.LOBBYFORGE_RELEASE_PUBLIC_KEY_PEM
): ManifestSignatureStatus {
  if (!publicKeyPem) return { status: 'not_configured', verified: false, required: false };
  if (!manifest.signature) return { status: 'missing', verified: false, required: true };

  try {
    const ok = verifySignature(
      null,
      Buffer.from(canonicalizeReleaseManifest(manifest), 'utf8'),
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

export async function loadReleaseManifest(source?: string): Promise<ReleaseManifest> {
  const manifestSource =
    source ??
    process.env.LOBBYFORGE_RELEASE_MANIFEST ??
    process.env.LOBBYFORGE_RELEASE_MANIFEST_URL ??
    DEFAULT_MANIFEST_PATH;

  if (/^https?:\/\//i.test(manifestSource)) {
    const url = new URL(manifestSource);
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      throw new Error('Production release manifests must use HTTPS.');
    }
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
    const declaredLength = Number(res.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_REMOTE_MANIFEST_BYTES) throw new Error('Manifest response is too large.');
    const raw = await res.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_REMOTE_MANIFEST_BYTES) {
      throw new Error('Manifest response is too large.');
    }
    return validateManifest(JSON.parse(raw));
  }

  if (path.isAbsolute(manifestSource)) {
    throw new Error('Local release manifest paths must be relative to infra/update.');
  }
  const relativeSource = manifestSource.replace(/^infra[\\/]update[\\/]/, '');
  const roots = [
    path.resolve(/* turbopackIgnore: true */ process.cwd(), 'infra', 'update'),
    path.resolve(/* turbopackIgnore: true */ process.cwd(), '..', '..', 'infra', 'update'),
  ];
  const candidates = roots.map((root) => {
    const absolute = path.resolve(root, relativeSource);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Local release manifest must stay inside infra/update.');
    }
    return absolute;
  });
  let lastError: unknown;
  for (const absolute of [...new Set(candidates)]) {
    try {
      const raw = await fs.readFile(absolute, 'utf8');
      return validateManifest(JSON.parse(raw));
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw lastError;
}

export function buildUpdateCheck(
  manifest: ReleaseManifest,
  currentVersion = process.env.LOBBYFORGE_VERSION ?? DEFAULT_CURRENT_VERSION,
  channel = DEFAULT_CHANNEL
): UpdateCheck {
  const latestVersion = manifest.version;
  const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
  const latest = parseVersion(latestVersion);
  const current = parseVersion(currentVersion);
  return {
    channel: manifest.channel ?? channel,
    currentVersion,
    latestVersion,
    updateAvailable,
    majorUpgrade: latest.major > current.major,
    currentSupported: manifest.minimumVersion
      ? compareVersions(currentVersion, manifest.minimumVersion) >= 0
      : true,
    releaseNotes: manifest.releaseNotes ?? '',
    breakingChanges: manifest.breakingChanges ?? [],
    signature: verifyReleaseManifestSignature(manifest),
  };
}

function command(commands: Record<string, string>, key: string, fallback: string): string {
  const value = commands[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

export function buildUpdatePlan(
  manifest: ReleaseManifest,
  currentVersion = process.env.LOBBYFORGE_VERSION ?? DEFAULT_CURRENT_VERSION,
  channel = DEFAULT_CHANNEL
): UpdatePlan {
  const check = buildUpdateCheck(manifest, currentVersion, channel);
  const commands = manifest.commands ?? {};
  const migrations = manifest.migrations ?? {};
  return {
    ...check,
    safeToAutoApply: false,
    requiresAdminConfirmation: true,
    requiresExtraMajorConfirmation: check.majorUpgrade,
    rollbackCommand: command(commands, 'rollback', 'docker compose up -d --remove-orphans'),
    steps: [
      {
        id: 'preflight-doctor',
        title: 'Run Doctor preflight',
        required: true,
        command: command(commands, 'doctor', 'lfctl doctor'),
      },
      {
        id: 'backup',
        title: 'Create database/config backup',
        required: true,
        command: command(commands, 'backup', 'lfctl backup create'),
      },
      {
        id: 'pull-images',
        title: 'Pull new Docker images',
        required: true,
        command: command(commands, 'composePull', 'docker compose pull'),
      },
      {
        id: 'migration-dry-run',
        title: 'Review migration plan',
        required: true,
        command: migrations.dryRunCommand ?? 'pnpm --filter @lobbyforge/db db:generate -- --dry-run',
      },
      {
        id: 'apply-migrations',
        title: 'Apply database migrations',
        required: true,
        command: migrations.applyCommand ?? 'pnpm --filter @lobbyforge/db db:migrate',
      },
      {
        id: 'recreate-services',
        title: 'Recreate services',
        required: true,
        command: command(commands, 'composeUp', 'docker compose up -d --remove-orphans'),
      },
      {
        id: 'health-check',
        title: 'Run health smoke test',
        required: true,
        command: command(commands, 'healthCheck', 'curl -fsS http://localhost:3000/api/health'),
      },
    ],
  };
}
