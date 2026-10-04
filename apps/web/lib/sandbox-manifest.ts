/**
 * The `sandbox-v1` bundle manifest (ADR-007), as the INSTALLER checks it.
 *
 * A marketplace bundle is `manifest.json` + `server.js` (+ optional `ui/`).
 * The manifest is DATA the host trusts for authorization decisions — the
 * action policies decide who may send which action — so it is validated
 * strictly, and the web app reads it from its own copy of the installed
 * files (never from the plugin worker's answer or from plugin code).
 *
 * Twin of apps/plugin-worker/src/manifest.ts. Both run the same table of
 * cases (apps/plugin-worker/src/__tests__/fixtures/manifest-cases.json);
 * keep them in step.
 */

export const SANDBOX_SDK = 'sandbox-v1';

/** Same role set and fields as `GamePluginActionPolicy` in @lobbyforge/plugin-sdk. */
export interface SandboxActionPolicy {
  role: 'host' | 'member' | 'player';
  actorFields?: string[];
  joinsRoster?: boolean;
  audit?: boolean;
}

export interface SandboxManifest {
  id: string;
  name: string;
  version: string;
  sdk: typeof SANDBOX_SDK;
  actionPolicies: Record<string, SandboxActionPolicy>;
  minPlayers?: number;
  maxPlayers?: number;
  locales: string[];
  ui: boolean;
}

export type ManifestValidation = { ok: true; manifest: SandboxManifest } | { ok: false; error: string };

/** 2–64 characters: longer ids install but can never be enabled (EXTENDING.md §3.2). */
export const SANDBOX_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;
export const SANDBOX_VERSION_RE = /^\d+\.\d+\.\d+(-[a-z0-9.-]+)?(\+[a-z0-9.-]+)?$/i;
/** Action types: the actions route accepts `type` of 1–64 characters. */
const ACTION_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const ROLES = new Set(['host', 'member', 'player']);
const POLICY_KEYS = new Set(['role', 'actorFields', 'joinsRoster', 'audit']);
/** Names that must never become object keys on the host (prototype pollution) or be overwritten. */
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'type', 'actionId']);

export const MAX_ACTION_POLICIES = 64;
export const MAX_ACTOR_FIELDS = 8;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_PLAYERS_CEILING = 500;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlayerCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_PLAYERS_CEILING;
}

/** Validate a parsed manifest.json. Unknown top-level keys are ignored; unknown policy keys are refused. */
export function validateSandboxManifest(raw: unknown): ManifestValidation {
  const fail = (error: string): ManifestValidation => ({ ok: false, error: `manifest.json: ${error}` });
  if (!isPlainObject(raw)) return fail('must be a JSON object');

  if (raw.sdk !== SANDBOX_SDK) {
    return fail(`"sdk" must be "${SANDBOX_SDK}" (legacy Node bundles no longer load; see docs/PLUGIN_PUBLISHING.md)`);
  }
  if (typeof raw.id !== 'string' || !SANDBOX_PLUGIN_ID_RE.test(raw.id)) {
    return fail('"id" must be 2-64 characters of letters, digits, "-" or "_", starting with a letter or digit');
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.length > 80) {
    return fail('"name" must be a non-empty string of at most 80 characters');
  }
  if (typeof raw.version !== 'string' || !SANDBOX_VERSION_RE.test(raw.version)) {
    return fail('"version" must be strict semver (e.g. 1.0.0)');
  }
  if (typeof raw.ui !== 'boolean') return fail('"ui" must be true or false');

  if (!isPlainObject(raw.actionPolicies)) return fail('"actionPolicies" must be an object (it may be empty)');
  const entries = Object.keys(raw.actionPolicies);
  if (entries.length > MAX_ACTION_POLICIES) return fail(`"actionPolicies" has more than ${MAX_ACTION_POLICIES} entries`);
  const actionPolicies: Record<string, SandboxActionPolicy> = Object.create(null) as Record<string, SandboxActionPolicy>;
  for (const actionType of entries) {
    if (!ACTION_TYPE_RE.test(actionType) || RESERVED_NAMES.has(actionType)) {
      return fail(`action type "${actionType.slice(0, 64)}" is not allowed (1-64 of A-Z a-z 0-9 _ . : -)`);
    }
    const policy = (raw.actionPolicies as Record<string, unknown>)[actionType];
    if (!isPlainObject(policy)) return fail(`actionPolicies["${actionType}"] must be an object`);
    for (const key of Object.keys(policy)) {
      if (!POLICY_KEYS.has(key)) return fail(`actionPolicies["${actionType}"] has an unknown key "${key.slice(0, 32)}"`);
    }
    if (typeof policy.role !== 'string' || !ROLES.has(policy.role)) {
      return fail(`actionPolicies["${actionType}"].role must be "host", "member" or "player"`);
    }
    const clean: SandboxActionPolicy = { role: policy.role as SandboxActionPolicy['role'] };
    if (policy.actorFields !== undefined) {
      if (!Array.isArray(policy.actorFields) || policy.actorFields.length > MAX_ACTOR_FIELDS) {
        return fail(`actionPolicies["${actionType}"].actorFields must be an array of at most ${MAX_ACTOR_FIELDS} field names`);
      }
      const fields: string[] = [];
      for (const field of policy.actorFields) {
        if (typeof field !== 'string' || !FIELD_RE.test(field) || RESERVED_NAMES.has(field)) {
          return fail(`actionPolicies["${actionType}"].actorFields has an invalid field name`);
        }
        if (!fields.includes(field)) fields.push(field);
      }
      clean.actorFields = fields;
    }
    if (policy.joinsRoster !== undefined) {
      if (typeof policy.joinsRoster !== 'boolean') return fail(`actionPolicies["${actionType}"].joinsRoster must be a boolean`);
      clean.joinsRoster = policy.joinsRoster;
    }
    if (policy.audit !== undefined) {
      if (typeof policy.audit !== 'boolean') return fail(`actionPolicies["${actionType}"].audit must be a boolean`);
      clean.audit = policy.audit;
    }
    actionPolicies[actionType] = clean;
  }

  if (raw.minPlayers !== undefined && !isPlayerCount(raw.minPlayers)) {
    return fail(`"minPlayers" must be an integer from 1 to ${MAX_PLAYERS_CEILING}`);
  }
  if (raw.maxPlayers !== undefined && !isPlayerCount(raw.maxPlayers)) {
    return fail(`"maxPlayers" must be an integer from 1 to ${MAX_PLAYERS_CEILING}`);
  }
  if (isPlayerCount(raw.minPlayers) && isPlayerCount(raw.maxPlayers) && raw.minPlayers > raw.maxPlayers) {
    return fail('"minPlayers" must not exceed "maxPlayers"');
  }

  let locales: string[] = ['en'];
  if (raw.locales !== undefined) {
    if (!Array.isArray(raw.locales) || raw.locales.length === 0 || raw.locales.length > 32) {
      return fail('"locales" must be a non-empty array of at most 32 language codes');
    }
    locales = [];
    for (const code of raw.locales) {
      if (typeof code !== 'string' || !LOCALE_RE.test(code)) return fail('"locales" has an invalid language code');
      if (!locales.includes(code)) locales.push(code);
    }
  }

  // A plain prototype again for consumers (the null-prototype map only
  // guarded the copy loop); keys were checked against RESERVED_NAMES.
  const policies: Record<string, SandboxActionPolicy> = {};
  for (const key of Object.keys(actionPolicies)) policies[key] = actionPolicies[key]!;

  const manifest: SandboxManifest = {
    id: raw.id,
    name: raw.name.trim(),
    version: raw.version,
    sdk: SANDBOX_SDK,
    actionPolicies: policies,
    locales,
    ui: raw.ui,
  };
  if (isPlayerCount(raw.minPlayers)) manifest.minPlayers = raw.minPlayers;
  if (isPlayerCount(raw.maxPlayers)) manifest.maxPlayers = raw.maxPlayers;
  return { ok: true, manifest };
}

/** Parse manifest.json bytes (size-capped) and validate. */
export function parseSandboxManifest(bytes: Buffer | string): ManifestValidation {
  const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
  if (size > MAX_MANIFEST_BYTES) return { ok: false, error: `manifest.json: larger than ${MAX_MANIFEST_BYTES} bytes` };
  let raw: unknown;
  try {
    raw = JSON.parse(typeof bytes === 'string' ? bytes : bytes.toString('utf8'));
  } catch {
    return { ok: false, error: 'manifest.json: not valid JSON' };
  }
  return validateSandboxManifest(raw);
}
