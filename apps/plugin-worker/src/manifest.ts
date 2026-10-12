/**
 * The `sandbox-v1` bundle manifest (ADR-007).
 *
 * A marketplace bundle is `manifest.json` + `server.js` (+ optional `ui/`
 * and `locales/<code>.json`). The manifest is DATA the host trusts for
 * authorization decisions — the action policies decide who may send which
 * action — so it is validated strictly, and never taken from plugin code.
 * The worker checks the locale tables too (`parseSandboxBundle`) so it
 * refuses exactly the bundles the installer refuses, though it never uses
 * them.
 *
 * This validator has a twin in the web app (apps/web/lib/sandbox-manifest.ts,
 * used by the installer). Both run the same table of cases
 * (src/__tests__/fixtures/manifest-cases.json); keep them in step.
 */

export const SANDBOX_SDK = 'sandbox-v1';

/** Same role set and fields as `GamePluginActionPolicy` in @lobbyforge/plugin-sdk. */
export interface SandboxActionPolicy {
  role: 'host' | 'member' | 'player';
  actorFields?: string[];
  joinsRoster?: boolean;
  audit?: boolean;
  /** A member/player action someone outside the voice room may send (leaving). */
  allowOutsideVoice?: boolean;
}

/**
 * Outside origins a plugin asks to reach from its UI (docs/PLUGIN_UNLOCK_PLAN.md,
 * phase 2). Each is an https origin on a public host. Nothing here takes
 * effect until the instance owner approves it at install.
 */
export interface SandboxNetwork {
  connect?: string[];
  img?: string[];
  media?: string[];
  frame?: string[];
}

export const SANDBOX_NETWORK_KINDS = ['connect', 'img', 'media', 'frame'] as const;
export type SandboxNetworkKind = (typeof SANDBOX_NETWORK_KINDS)[number];

/** Host effects a plugin asks to use (phase 3), approved at install like the network. */
export const SANDBOX_PERMISSIONS = ['timers', 'storage', 'chat', 'voice.mute'] as const;
export type SandboxPermission = (typeof SANDBOX_PERMISSIONS)[number];

export interface SandboxManifest {
  id: string;
  name: string;
  version: string;
  sdk: typeof SANDBOX_SDK;
  actionPolicies: Record<string, SandboxActionPolicy>;
  minPlayers?: number;
  maxPlayers?: number;
  locales: string[];
  /** The bundle serves its UI from `ui/` (false for `ui: { url }`, which serves no files). */
  ui: boolean;
  /** `ui: { "url": … }`: the UI is the author's own page, framed by the lobby (phase 2). */
  uiUrl?: string;
  network?: SandboxNetwork;
  permissions?: SandboxPermission[];
  /** Players must be in the activity's voice room: the host refuses member/player actions from outside it. */
  requiresVoiceRoom?: boolean;
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
const POLICY_KEYS = new Set(['role', 'actorFields', 'joinsRoster', 'audit', 'allowOutsideVoice']);
/** Names that must never become object keys on the host (prototype pollution) or be overwritten. */
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'type', 'actionId']);

export const MAX_ACTION_POLICIES = 64;
export const MAX_ACTOR_FIELDS = 8;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_PLAYERS_CEILING = 500;
export const MAX_ORIGINS_PER_KIND = 8;
export const MAX_UI_URL_LENGTH = 2048;

/** What a manifest may relax, for local development and tests only (never production). */
export interface SandboxManifestOptions {
  /** Accept http: and local hosts (localhost, 127.0.0.1, *.local …) in `network` and `ui.url`. */
  allowLocalOrigins?: boolean;
}

/** Host names that point into the viewer's own machine or network. */
const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/**
 * A host a viewer's browser may be sent to: a DNS name with a dot, not an IP
 * literal (the URL parser has already turned `0x7f.1` and friends into
 * dotted IPv4) and not a local name — otherwise a plugin could turn every
 * viewer's browser into a scanner of their own network.
 */
function isPublicHost(host: string): boolean {
  if (host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  // Letters, digits, dots and hyphens only (IDNs arrive as punycode): no wildcard.
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || host.endsWith('.')) return false;
  return host !== 'localhost' && !LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function allowedUrl(url: URL, options: SandboxManifestOptions): boolean {
  if (url.username || url.password) return false;
  if (options.allowLocalOrigins) return url.protocol === 'https:' || url.protocol === 'http:';
  return url.protocol === 'https:' && isPublicHost(url.hostname);
}

/**
 * An origin as written in `network`: `https://host[:port]`, nothing more (a
 * trailing slash is tolerated) — no path, query, fragment, credentials or
 * wildcard. Returns the normalized origin, or null.
 */
export function normalizeOutsideOrigin(value: unknown, options: SandboxManifestOptions = {}): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!allowedUrl(url, options)) return null;
  // The written value itself must be the origin: nothing the parser dropped.
  const written = value.toLowerCase();
  if (written !== url.origin && written !== `${url.origin}/`) return null;
  return url.origin;
}

/** `ui.url`: an absolute https URL on a public host, without credentials or fragment. Normalized, or null. */
export function normalizeUiUrl(value: unknown, options: SandboxManifestOptions = {}): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_UI_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!allowedUrl(url, options) || url.hash) return null;
  return url.href;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlayerCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_PLAYERS_CEILING;
}

/** Validate a parsed manifest.json. Unknown top-level keys are ignored; unknown policy keys are refused. */
export function validateSandboxManifest(raw: unknown, options: SandboxManifestOptions = {}): ManifestValidation {
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
  let uiFiles: boolean;
  let uiUrl: string | undefined;
  if (typeof raw.ui === 'boolean') {
    uiFiles = raw.ui;
  } else if (isPlainObject(raw.ui) && Object.keys(raw.ui).length === 1 && 'url' in raw.ui) {
    const url = normalizeUiUrl(raw.ui.url, options);
    if (!url) return fail('"ui.url" must be an https URL on a public host, without credentials or fragment');
    uiFiles = false;
    uiUrl = url;
  } else {
    return fail('"ui" must be true, false or { "url": "https://…" }');
  }

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
    if (policy.allowOutsideVoice !== undefined) {
      if (typeof policy.allowOutsideVoice !== 'boolean') {
        return fail(`actionPolicies["${actionType}"].allowOutsideVoice must be a boolean`);
      }
      clean.allowOutsideVoice = policy.allowOutsideVoice;
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
  if (raw.requiresVoiceRoom !== undefined && typeof raw.requiresVoiceRoom !== 'boolean') {
    return fail('"requiresVoiceRoom" must be true or false');
  }

  let network: SandboxNetwork | undefined;
  if (raw.network !== undefined) {
    if (!isPlainObject(raw.network)) return fail('"network" must be an object');
    for (const key of Object.keys(raw.network)) {
      if (!(SANDBOX_NETWORK_KINDS as readonly string[]).includes(key)) {
        return fail(`"network" has an unknown key "${key.slice(0, 32)}" (connect, img, media, frame)`);
      }
    }
    const asked: SandboxNetwork = {};
    for (const kind of SANDBOX_NETWORK_KINDS) {
      const list = raw.network[kind];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.length > MAX_ORIGINS_PER_KIND) {
        return fail(`"network.${kind}" must be an array of at most ${MAX_ORIGINS_PER_KIND} origins`);
      }
      const origins: string[] = [];
      for (const value of list) {
        const origin = normalizeOutsideOrigin(value, options);
        if (!origin) {
          return fail(`"network.${kind}" has "${String(value).slice(0, 80)}", which is not an https origin on a public host`);
        }
        if (!origins.includes(origin)) origins.push(origin);
      }
      if (origins.length > 0) asked[kind] = origins;
    }
    if (Object.keys(asked).length > 0) network = asked;
  }

  let permissions: SandboxPermission[] | undefined;
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions) || raw.permissions.length > SANDBOX_PERMISSIONS.length) {
      return fail(`"permissions" must be an array of at most ${SANDBOX_PERMISSIONS.length} names`);
    }
    const names: SandboxPermission[] = [];
    for (const name of raw.permissions) {
      if (typeof name !== 'string' || !(SANDBOX_PERMISSIONS as readonly string[]).includes(name)) {
        return fail(`"permissions" has an unknown name "${String(name).slice(0, 32)}" (${SANDBOX_PERMISSIONS.join(', ')})`);
      }
      if (!names.includes(name as SandboxPermission)) names.push(name as SandboxPermission);
    }
    if (names.length > 0) permissions = names;
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
    ui: uiFiles,
  };
  if (uiUrl) manifest.uiUrl = uiUrl;
  if (network) manifest.network = network;
  if (permissions) manifest.permissions = permissions;
  if (isPlayerCount(raw.minPlayers)) manifest.minPlayers = raw.minPlayers;
  if (isPlayerCount(raw.maxPlayers)) manifest.maxPlayers = raw.maxPlayers;
  if (typeof raw.requiresVoiceRoom === 'boolean') manifest.requiresVoiceRoom = raw.requiresVoiceRoom;
  return { ok: true, manifest };
}

function byteLength(bytes: Buffer | string): number {
  return typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
}

function utf8(bytes: Buffer | string): string {
  return typeof bytes === 'string' ? bytes : bytes.toString('utf8');
}

/** manifest.json bytes → parsed JSON (size-capped), not yet validated. */
function readManifestJson(bytes: Buffer | string): { ok: true; raw: unknown } | { ok: false; error: string } {
  if (byteLength(bytes) > MAX_MANIFEST_BYTES) return { ok: false, error: `manifest.json: larger than ${MAX_MANIFEST_BYTES} bytes` };
  try {
    return { ok: true, raw: JSON.parse(utf8(bytes)) };
  } catch {
    return { ok: false, error: 'manifest.json: not valid JSON' };
  }
}

/** Parse manifest.json bytes (size-capped) and validate. */
export function parseSandboxManifest(bytes: Buffer | string, options: SandboxManifestOptions = {}): ManifestValidation {
  const read = readManifestJson(bytes);
  return read.ok ? validateSandboxManifest(read.raw, options) : read;
}

// ── Translations: `locales/<code>.json` ─────────────────────────────────
//
// A bundle may ship one flat key → string table per language, the same
// shape as an official plugin's `plugins/<id>/locales/<code>.json`. The
// host registers them under the plugin's id, so `catalog.name` and
// `catalog.summary` name and describe the plugin in each viewer's
// language on the host's own screens (the lobby, the app lists, the
// marketplace). The tables are DATA shown to every member of the
// instance, so they are capped and checked as strictly as the manifest:
// a bundle with a malformed file is refused as a whole, never loaded with
// the file silently dropped.

/** One language's table: flat key → text (the ICU subset of `formatMessage`). */
export type SandboxLocaleTable = Record<string, string>;

/** A file under the bundle's `locales/` folder: its path below `locales/` (POSIX separators) and its bytes. */
export type SandboxLocaleFile = readonly [path: string, bytes: Buffer | string];

export type LocaleFilesValidation =
  | { ok: true; tables: Record<string, SandboxLocaleTable> }
  | { ok: false; error: string };

export type BundleValidation =
  | { ok: true; manifest: SandboxManifest; localeTables: Record<string, SandboxLocaleTable> }
  | { ok: false; error: string };

export const MAX_LOCALE_FILES = 32;
export const MAX_LOCALE_FILE_BYTES = 128 * 1024;
export const MAX_LOCALE_TOTAL_BYTES = 1024 * 1024;
export const MAX_LOCALE_KEYS = 1000;
export const MAX_LOCALE_KEY_LENGTH = 128;
export const MAX_LOCALE_VALUE_LENGTH = 4096;
/** `catalog.name` has the manifest `name`'s cap, `catalog.summary` the marketplace summary's. */
export const MAX_CATALOG_NAME_LENGTH = 80;
export const MAX_CATALOG_SUMMARY_LENGTH = 200;

/** `<code>.json`, the code in the app's own format (`tr`, `pt-BR`, `zh-Hans`). */
const LOCALE_FILE_RE = /^([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.json$/;
/** Flat keys like the official plugins' (`catalog.name`, `round.open`); `$status`-style metadata is allowed. */
const LOCALE_KEY_RE = /^[A-Za-z0-9_$][A-Za-z0-9_.:$-]*$/;
/** Keys that must never become object keys on the host. */
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** C0 controls other than tab and newline, and DEL: never part of a label. */
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;

/** A path or key as it may appear in an error message: short, printable ASCII. */
function printable(text: string): string {
  return text.slice(0, 64).replace(/[^\x20-\x7e]/g, '?');
}

/**
 * Validate the files of a bundle's `locales/` folder. Every file must be a
 * `<code>.json` directly in `locales/` holding a JSON object of string
 * values; sizes, key counts and lengths are capped; `catalog.name` must be
 * one line of at most 80 characters and `catalog.summary` at most 200. A
 * blank value is allowed: it means "not translated yet" and falls back.
 */
export function validateSandboxLocaleFiles(files: readonly SandboxLocaleFile[]): LocaleFilesValidation {
  const fail = (error: string): LocaleFilesValidation => ({ ok: false, error });
  if (files.length > MAX_LOCALE_FILES) return fail(`locales/: more than ${MAX_LOCALE_FILES} files`);
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const tables: Record<string, SandboxLocaleTable> = {};
  const seen = new Map<string, string>();
  let total = 0;
  for (const [path, bytes] of sorted) {
    const where = `locales/${printable(path)}`;
    const match = LOCALE_FILE_RE.exec(path);
    if (!match) {
      return fail(`${where}: only <language code>.json files may sit in locales/ (e.g. tr.json, pt-BR.json)`);
    }
    const code = match[1]!;
    const clash = seen.get(code.toLowerCase());
    if (clash !== undefined) return fail(`${where}: names the same language as locales/${clash}.json`);
    seen.set(code.toLowerCase(), code);

    const size = byteLength(bytes);
    if (size > MAX_LOCALE_FILE_BYTES) return fail(`${where}: larger than ${MAX_LOCALE_FILE_BYTES} bytes`);
    total += size;
    if (total > MAX_LOCALE_TOTAL_BYTES) return fail(`locales/: the files add up to more than ${MAX_LOCALE_TOTAL_BYTES} bytes`);

    let raw: unknown;
    try {
      // A byte-order mark is what some editors save; it is not content.
      raw = JSON.parse(utf8(bytes).replace(/^\uFEFF/, ''));
    } catch {
      return fail(`${where}: not valid JSON`);
    }
    if (!isPlainObject(raw)) return fail(`${where}: must be a JSON object of "key": "text" pairs`);
    const keys = Object.keys(raw);
    if (keys.length > MAX_LOCALE_KEYS) return fail(`${where}: more than ${MAX_LOCALE_KEYS} keys`);
    const table: SandboxLocaleTable = {};
    for (const key of keys) {
      if (key.length > MAX_LOCALE_KEY_LENGTH || !LOCALE_KEY_RE.test(key) || PROTOTYPE_KEYS.has(key)) {
        return fail(`${where}: key "${printable(key)}" is not allowed (1-${MAX_LOCALE_KEY_LENGTH} of A-Z a-z 0-9 _ . : - $)`);
      }
      const value = raw[key];
      if (typeof value !== 'string') {
        return fail(`${where}: "${key}" must be a string (the file is flat: one "key": "text" pair per string)`);
      }
      if (value.length > MAX_LOCALE_VALUE_LENGTH) {
        return fail(`${where}: "${key}" is longer than ${MAX_LOCALE_VALUE_LENGTH} characters`);
      }
      if (CONTROL_CHAR_RE.test(value)) return fail(`${where}: "${key}" contains a control character`);
      table[key] = value;
    }
    const name = table['catalog.name'];
    if (name !== undefined && (name.trim().length > MAX_CATALOG_NAME_LENGTH || /[\r\n]/.test(name))) {
      return fail(`${where}: "catalog.name" must be one line of at most ${MAX_CATALOG_NAME_LENGTH} characters`);
    }
    const summary = table['catalog.summary'];
    if (summary !== undefined && summary.trim().length > MAX_CATALOG_SUMMARY_LENGTH) {
      return fail(`${where}: "catalog.summary" must be at most ${MAX_CATALOG_SUMMARY_LENGTH} characters`);
    }
    tables[code] = table;
  }
  return { ok: true, tables };
}

/**
 * Validate a bundle's metadata as a whole: manifest.json and the files of
 * its `locales/` folder (an empty list when it has none).
 *
 * The plugin's languages are the ones it ships tables for. `"locales"` in
 * the manifest is optional; when the bundle has locale files and the
 * manifest lists languages too, the two must name the same codes, so a
 * forgotten file or a stale list is caught at install time. Without locale
 * files the manifest's list (default `["en"]`) stands, as before.
 */
export function parseSandboxBundle(
  manifestBytes: Buffer | string,
  localeFiles: readonly SandboxLocaleFile[],
  options: SandboxManifestOptions = {}
): BundleValidation {
  const read = readManifestJson(manifestBytes);
  if (!read.ok) return read;
  const checked = validateSandboxManifest(read.raw, options);
  if (!checked.ok) return checked;
  const files = validateSandboxLocaleFiles(localeFiles);
  if (!files.ok) return files;

  const manifest = checked.manifest;
  const shipped = Object.keys(files.tables);
  if (shipped.length === 0) return { ok: true, manifest, localeTables: {} };
  const declared = isPlainObject(read.raw) && read.raw.locales !== undefined ? manifest.locales : null;
  if (declared) {
    const missing = declared.find((code) => !shipped.includes(code));
    if (missing !== undefined) {
      return {
        ok: false,
        error: `manifest.json: "locales" lists "${missing}" but the bundle has no locales/${missing}.json (list exactly the languages in locales/, or leave "locales" out)`,
      };
    }
    const unlisted = shipped.find((code) => !declared.includes(code));
    if (unlisted !== undefined) {
      return {
        ok: false,
        error: `locales/${unlisted}.json: "${unlisted}" is missing from "locales" in manifest.json (list exactly the languages in locales/, or leave "locales" out)`,
      };
    }
  }
  // The manifest's order when it gives one, else the files' (sorted).
  const codes = declared ?? shipped;
  const localeTables: Record<string, SandboxLocaleTable> = {};
  for (const code of codes) localeTables[code] = files.tables[code]!;
  return { ok: true, manifest: { ...manifest, locales: [...codes] }, localeTables };
}
