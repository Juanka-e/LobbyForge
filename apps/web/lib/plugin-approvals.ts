/**
 * What a marketplace plugin asks for beyond the sandbox, and what the
 * instance owner approved (docs/PLUGIN_UNLOCK_PLAN.md, "Ortak temel").
 *
 * A sandbox-v1 manifest may ask for outside origins (`network`), for its UI
 * to be the author's own page (`ui: { url }`) and for host effects
 * (`permissions`). None of it takes effect because a manifest says so: the
 * install route refuses with `approval_required` until the request carries
 * an `approve` that names exactly what the bundle asks for, the active
 * record (`active.json`) keeps what was approved, and every consumer grants
 * only `effectiveApprovals` — what the manifest asks for AND the record
 * approved. A bundle installed before approvals existed, whose manifest
 * already carried these keys, therefore gets nothing until it is approved.
 */
import {
  SANDBOX_NETWORK_KINDS,
  SANDBOX_PERMISSIONS,
  normalizeOutsideOrigin,
  normalizeUiUrl,
  type SandboxManifest,
  type SandboxManifestOptions,
  type SandboxNetwork,
  type SandboxPermission,
} from './sandbox-manifest';

export interface PluginApprovals {
  network?: SandboxNetwork;
  uiUrl?: string;
  permissions?: SandboxPermission[];
}

/** Local development and tests only: http: and local hosts in `network` / `ui.url`. */
export function sandboxManifestOptions(env: Record<string, string | undefined> = process.env): SandboxManifestOptions {
  return { allowLocalOrigins: env.LOBBYFORGE_PLUGIN_ALLOW_LOCAL_ORIGINS === 'true' && env.NODE_ENV !== 'production' };
}

function sorted(list: readonly string[] | undefined): string[] {
  return [...new Set(list ?? [])].sort();
}

/** One canonical shape: sorted, de-duplicated, empty parts left out. */
function canonical(approvals: PluginApprovals | null | undefined): PluginApprovals {
  const out: PluginApprovals = {};
  const network: SandboxNetwork = {};
  for (const kind of SANDBOX_NETWORK_KINDS) {
    const list = sorted(approvals?.network?.[kind]);
    if (list.length > 0) network[kind] = list;
  }
  if (Object.keys(network).length > 0) out.network = network;
  if (approvals?.uiUrl) out.uiUrl = approvals.uiUrl;
  const permissions = sorted(approvals?.permissions) as SandboxPermission[];
  if (permissions.length > 0) out.permissions = permissions;
  return out;
}

function isEmpty(approvals: PluginApprovals): boolean {
  return !approvals.network && !approvals.uiUrl && !approvals.permissions;
}

/** What this manifest asks the owner to approve, or null when it asks for nothing. */
export function requestedApprovals(manifest: SandboxManifest): PluginApprovals | null {
  const requested = canonical({ network: manifest.network, uiUrl: manifest.uiUrl, permissions: manifest.permissions });
  return isEmpty(requested) ? null : requested;
}

/** Exactly the same request (order and duplicates do not matter). */
export function sameApprovals(a: PluginApprovals | null | undefined, b: PluginApprovals | null | undefined): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** What `requested` asks for that `previous` did not approve — the new part an upgrade asks about. Null when nothing is new. */
export function newApprovals(previous: PluginApprovals | null | undefined, requested: PluginApprovals | null): PluginApprovals | null {
  if (!requested) return null;
  const before = canonical(previous);
  const diff: PluginApprovals = {};
  const network: SandboxNetwork = {};
  for (const kind of SANDBOX_NETWORK_KINDS) {
    const fresh = (requested.network?.[kind] ?? []).filter((origin) => !(before.network?.[kind] ?? []).includes(origin));
    if (fresh.length > 0) network[kind] = fresh;
  }
  if (Object.keys(network).length > 0) diff.network = network;
  if (requested.uiUrl && requested.uiUrl !== before.uiUrl) diff.uiUrl = requested.uiUrl;
  const permissions = (requested.permissions ?? []).filter((name) => !(before.permissions ?? []).includes(name));
  if (permissions.length > 0) diff.permissions = permissions;
  return isEmpty(diff) ? null : diff;
}

/**
 * What a plugin may actually use: what its manifest asks for, and only as
 * far as the active record approved it. Pass the record's `approved`.
 */
export function effectiveApprovals(manifest: SandboxManifest, approved: PluginApprovals | null | undefined): PluginApprovals {
  const grant = canonical(approved);
  const out: PluginApprovals = {};
  const network: SandboxNetwork = {};
  for (const kind of SANDBOX_NETWORK_KINDS) {
    const list = (manifest.network?.[kind] ?? []).filter((origin) => grant.network?.[kind]?.includes(origin));
    if (list.length > 0) network[kind] = list;
  }
  if (Object.keys(network).length > 0) out.network = network;
  if (manifest.uiUrl && manifest.uiUrl === grant.uiUrl) out.uiUrl = manifest.uiUrl;
  const permissions = (manifest.permissions ?? []).filter((name) => grant.permissions?.includes(name));
  if (permissions.length > 0) out.permissions = permissions;
  return out;
}

/** Does the manifest ask for anything the record has not approved? (The admin list shows "needs approval".) */
export function needsApproval(manifest: SandboxManifest, approved: PluginApprovals | null | undefined): boolean {
  return newApprovals(approved, requestedApprovals(manifest)) !== null;
}

/**
 * `approve` from a request body or `approved` from active.json, read with
 * the manifest's own rules. Null for anything malformed — which approves
 * nothing, so a bad value can only make the install ask again.
 */
export function parseApprovals(raw: unknown, options: SandboxManifestOptions = {}): PluginApprovals | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (key !== 'network' && key !== 'uiUrl' && key !== 'permissions') return null;
  }
  const out: PluginApprovals = {};
  if (value.network !== undefined) {
    if (typeof value.network !== 'object' || value.network === null || Array.isArray(value.network)) return null;
    const network: SandboxNetwork = {};
    for (const [kind, list] of Object.entries(value.network as Record<string, unknown>)) {
      if (!(SANDBOX_NETWORK_KINDS as readonly string[]).includes(kind) || !Array.isArray(list) || list.length > 8) return null;
      const origins: string[] = [];
      for (const item of list) {
        const origin = normalizeOutsideOrigin(item, options);
        if (!origin) return null;
        origins.push(origin);
      }
      network[kind as keyof SandboxNetwork] = origins;
    }
    out.network = network;
  }
  if (value.uiUrl !== undefined) {
    const url = normalizeUiUrl(value.uiUrl, options);
    if (!url) return null;
    out.uiUrl = url;
  }
  if (value.permissions !== undefined) {
    if (!Array.isArray(value.permissions)) return null;
    for (const name of value.permissions) {
      if (typeof name !== 'string' || !(SANDBOX_PERMISSIONS as readonly string[]).includes(name)) return null;
    }
    out.permissions = value.permissions as SandboxPermission[];
  }
  return canonical(out);
}
