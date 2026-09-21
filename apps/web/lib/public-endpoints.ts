/**
 * Browser-facing realtime/media endpoints.
 *
 * `NEXT_PUBLIC_*` values are inlined into every bundle at BUILD time, so an
 * image built without them (the release workflow publishes one image for
 * every instance) would ship whatever the Dockerfile defaulted to — before
 * the beta review that was `localhost`, which broke voice + realtime after
 * `lfctl update apply`. Resolution order:
 *
 *   server side → runtime env, read with a computed key (not inlined):
 *                 LOBBYFORGE_PUBLIC_LIVEKIT_URL, then NEXT_PUBLIC_LIVEKIT_URL
 *   browser     → the value handed over by the server (token response),
 *                 then the build-time value, then the same-origin reverse
 *                 proxy paths the production nginx template exposes
 *                 (`/livekit/`, `/ws`).
 */

function runtimeEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

/** The <meta> the server renders so browsers learn the realtime URL at runtime. */
export const REALTIME_URL_META = 'lobbyforge-realtime-url';

/** Server only: the realtime gateway URL browsers should use, or null (same-origin). */
export function getRuntimeRealtimeUrl(): string | null {
  return runtimeEnv('LOBBYFORGE_PUBLIC_WS_URL') ?? runtimeEnv(['NEXT_PUBLIC', 'WS_URL'].join('_')) ?? null;
}

/** Server only: the LiveKit URL browsers should connect to, or null (same-origin). */
export function getRuntimeLiveKitUrl(): string | null {
  return runtimeEnv('LOBBYFORGE_PUBLIC_LIVEKIT_URL') ?? runtimeEnv(['NEXT_PUBLIC', 'LIVEKIT_URL'].join('_')) ?? null;
}

function sameOriginWs(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

/** Browser: pick the LiveKit URL (server-provided → build-time → same-origin /livekit). */
export function resolveBrowserLiveKitUrl(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (candidate && candidate.trim()) return candidate.trim();
  }
  return sameOriginWs('/livekit');
}

/**
 * Browser: the realtime gateway URL. The server-rendered meta (resolved at
 * REQUEST time) wins, then a build-time value, then the same-origin `/ws`
 * proxy on HTTPS pages, then the sibling gateway port on plain-HTTP dev
 * pages — so one image can serve any deployment without build args.
 */
export function resolveBrowserRealtimeUrl(buildTimeUrl: string | undefined): string {
  // The server-rendered meta is resolved at REQUEST time, so one published
  // image serves any deployment; the build-time value stays as a fallback.
  const fromMeta =
    typeof document === 'undefined'
      ? undefined
      : document.querySelector(`meta[name="${REALTIME_URL_META}"]`)?.getAttribute('content')?.trim();
  if (fromMeta) return fromMeta;
  if (buildTimeUrl && buildTimeUrl.trim()) return buildTimeUrl.trim();
  if (window.location.protocol === 'https:') return sameOriginWs('/ws');
  return `ws://${window.location.hostname}:19521`;
}
