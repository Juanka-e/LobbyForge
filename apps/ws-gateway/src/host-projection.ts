/**
 * ADR-007: activity projection the gateway cannot do itself.
 *
 * Core's `projectActivityState` covers the official plugins only. A
 * marketplace plugin projects its state with its own `projectState`, run
 * in the plugin worker — on a network only the web app joins. So for any
 * plugin id outside core's rules (`isCoreProjectedPlugin`), the gateway
 * asks the web app, per viewer, over the compose-internal network:
 * `POST {LOBBYFORGE_INTERNAL_WEB_URL}/api/internal/activity-projection`,
 * signed with a key derived from LOBBYFORGE_SESSION_SECRET (which the
 * gateway already holds for guest cookies). Any failure throws; the caller
 * then forwards the event without state (fail closed).
 */
import { ACTIVITY_PROJECTION_PURPOSE, INTERNAL_SIGNATURE_HEADER, signInternalRequest } from '@lobbyforge/core';

const TIMEOUT_MS = 5_000;

/** The web app on the compose network (same default in every stack). */
export function internalWebUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.LOBBYFORGE_INTERNAL_WEB_URL?.trim() || 'http://web:3000').replace(/\/$/, '');
}

export interface HostProjectionRequest {
  serverId: string;
  sessionId: string;
  viewerUserId: string;
}

export interface HostProjection {
  state: unknown;
  status: string | null;
  revision: number | null;
}

export async function fetchHostProjection(
  request: HostProjectionRequest,
  fetchImpl: typeof fetch = fetch
): Promise<HostProjection> {
  const body = JSON.stringify({
    serverId: request.serverId,
    sessionId: request.sessionId,
    viewerUserId: request.viewerUserId,
  });
  const signature = signInternalRequest(process.env.LOBBYFORGE_SESSION_SECRET ?? '', ACTIVITY_PROJECTION_PURPOSE, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${internalWebUrl()}/api/internal/activity-projection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [INTERNAL_SIGNATURE_HEADER]: signature },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`web projection answered HTTP ${res.status}`);
    const json = (await res.json()) as { state?: unknown; status?: unknown; revision?: unknown } | null;
    if (!json || typeof json !== 'object' || !('state' in json)) throw new Error('web projection answered without a state');
    return {
      state: json.state,
      status: typeof json.status === 'string' ? json.status : null,
      revision: typeof json.revision === 'number' ? json.revision : null,
    };
  } finally {
    clearTimeout(timer);
  }
}
