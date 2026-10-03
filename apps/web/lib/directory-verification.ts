/**
 * Shared pieces of the official directory's write routes
 * (`/api/directory/*`): who may serve them, what a directory instance id
 * looks like, and how an instance's `.well-known` verification document
 * is fetched.
 */
import { NextResponse } from 'next/server';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { ssrfSafeGet } from '@/lib/ssrf-safe-fetch';

/**
 * security-review HUB-001: the shape of a directory instance id — the
 * UUID v4 each install gets in `instance_settings.directory_instance_id`
 * (migration 0039, `gen_random_uuid()`), lower-case as Postgres prints it.
 * `lfctl directory proof` checks the same pattern.
 */
export const DIRECTORY_INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * security-review HUB-001: ids that are the same on every install. Before
 * 0039 an instance could only publish its settings singleton key, which is
 * `self-host` everywhere (and `default` was the key the proof query looked
 * for) — whoever registered one of these first would own it for everybody.
 * Refused by name so even an old client gets a clear answer.
 */
export const RESERVED_DIRECTORY_INSTANCE_IDS: ReadonlySet<string> = new Set(['self-host', 'default']);

/** Why `instanceId` cannot be registered, or null when it can. */
export function directoryInstanceIdError(instanceId: string): string | null {
  if (RESERVED_DIRECTORY_INSTANCE_IDS.has(instanceId.trim().toLowerCase())) {
    return `instanceId "${instanceId.trim().toLowerCase()}" is shared by every LobbyForge install and cannot be registered. Use this instance's directory id (GET /api/admin/directory/config on the instance).`;
  }
  if (!DIRECTORY_INSTANCE_ID_PATTERN.test(instanceId)) {
    return "instanceId must be this instance's directory id, a UUID (GET /api/admin/directory/config on the instance).";
  }
  return null;
}

/**
 * security-review FILE-002: the directory lives on the official hub;
 * self-hosted instances call INTO it (ADR-006, PRODUCT_HUB_PLAN) and never
 * serve these routes for anyone. On any other deployment the write routes
 * answer 404 — the same as the directory pages, which redirect away — so a
 * self-hosted instance does not expose a verification fetcher at all.
 */
export function directoryWritesUnavailable(): NextResponse | null {
  return isOfficialDeployment() ? null : NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export interface VerificationDocument {
  instanceId?: unknown;
  publicKey?: unknown;
  proof?: unknown;
}

export function wellKnownVerificationUrl(origin: string): string {
  return `${origin.replace(/\/$/, '')}/.well-known/lobbyforge-verification`;
}

/**
 * Fetch an instance's `/.well-known/lobbyforge-verification` over the
 * SSRF-safe, IP-pinned client.
 *
 * security-review FILE-002: every way of NOT getting a document — DNS
 * failure, a blocked (private) address, refused connection, TLS error,
 * timeout, a non-2xx answer, a body that is not JSON — returns the SAME
 * message. The raw error used to go back to the caller ("Target resolves
 * to a blocked address: 172.20.0.4", ENOTFOUND, connect vs TLS failures),
 * which mapped the hub's internal network and made the route a port
 * scanner. The detail is logged here for the operator instead.
 */
export async function fetchVerificationDocument(
  origin: string,
  logTag: string
): Promise<{ ok: true; doc: VerificationDocument } | { ok: false; error: string }> {
  const wellKnown = wellKnownVerificationUrl(origin);
  const unavailable = {
    ok: false as const,
    error: `Could not read a verification document from ${wellKnown}. The instance must serve it over HTTPS (run lfctl directory proof, then POST it to /api/admin/directory/config on the instance).`,
  };
  let res: Awaited<ReturnType<typeof ssrfSafeGet>>;
  try {
    res = await ssrfSafeGet(wellKnown);
  } catch (err) {
    console.warn(`[${logTag}] verification fetch failed for ${wellKnown}: ${(err as Error).message}`);
    return unavailable;
  }
  if (!res.ok) {
    console.warn(`[${logTag}] verification endpoint ${wellKnown} returned HTTP ${res.status}`);
    return unavailable;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(res.body);
  } catch {
    console.warn(`[${logTag}] verification document at ${wellKnown} is not valid JSON`);
    return unavailable;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    console.warn(`[${logTag}] verification document at ${wellKnown} is not an object`);
    return unavailable;
  }
  return { ok: true, doc: doc as VerificationDocument };
}
