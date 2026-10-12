/**
 * Serving a marketplace plugin's UI to the lobby's sandboxed iframe (ADR-007,
 * "Client side"). The route is /api/plugin-ui/{pluginId}/{version}/{...path}
 * and maps to `<install root>/<pluginId>/<version>/ui/<path>`.
 *
 * What is served: files of the ACTIVE version (active.json, via
 * plugin-install-layout.ts) of an installed `sdk: "sandbox-v1"` bundle whose
 * manifest says `ui: true` — and only while dynamic plugins are enabled. Any
 * other version, plugin, path or extension is a 404, and so is an official
 * plugin's id (official-plugin-ids.ts): a marketplace bundle named like one
 * is never served. Nothing outside `ui/` is reachable (server.js and
 * manifest.json are not UI).
 *
 * Cost per request (security review PLUG-002): the route is public, so it
 * must stay cheap. The bundle is validated once per installed version — the
 * validated manifest is cached per (plugin, version, digest), bounded, and
 * emptied by every install (`resetPluginUiAssetCache`); only the small
 * active.json is read per request, so a changed or withdrawn approval
 * applies at once. A file is `stat`ed through its descriptor and STREAMED:
 * HEAD reads no body, a Range reads only that range. A per-address token
 * bucket in memory (no database, no Redis) answers 429 past a generous
 * burst — a game loads many files at once.
 *
 * The response headers are the security boundary, so every one is deliberate:
 *
 *  - CSP (the ADR's policy) plus `sandbox allow-scripts`. The iframe already
 *    has `sandbox="allow-scripts"`; repeating it in the CSP keeps the document
 *    in an opaque origin even when it is opened some other way (a link, a
 *    frame without the attribute), so a plugin page can never run as the app.
 *    `'self'`-only images/scripts/styles/fonts, and `fetch()`/XHR/WebSocket
 *    and media limited to the plugin's OWN files (see `pluginUiAssetSource`)
 *    — unless the instance owner approved outside origins at install
 *    (phase 2 of docs/PLUGIN_UNLOCK_PLAN.md). The HTML document's policy then
 *    adds the plugin's EFFECTIVE origins (asked for by its manifest AND
 *    approved, `effectiveApprovals`) to `connect-src`, `img-src`, `media-src`
 *    and `frame-src` (no frames otherwise). A page it nests inherits its
 *    sandbox flags, so that page runs in an opaque origin too, without
 *    cookies or storage. `'wasm-unsafe-eval'` lets it compile WebAssembly,
 *    which reaches nothing a script cannot. `frame-ancestors 'self'`: only
 *    the app's own pages can frame it.
 *  - What that policy does NOT promise (security review PLUG-004): "no
 *    network" is more than CSP can enforce. It stops fetch, XHR, WebSocket,
 *    image and media requests beyond the plugin's own files and the approved
 *    origins. It does not cover WebRTC: a frame can open an
 *    RTCPeerConnection, whose STUN/TURN traffic `connect-src` does not
 *    govern. `webrtc 'block'` asks for that to be refused, but only some
 *    browsers implement the directive (the rest ignore it, harmlessly). Nor
 *    does the frame's own policy govern where the frame navigates ITSELF:
 *    that is the embedding page's `frame-src`, so the frame can load any
 *    origin the lobby page may frame. Treat what the frame is given — the
 *    viewer's projected state — as readable by the plugin's author.
 *  - Single `Range` requests answer 206, so audio and video can seek (Safari
 *    plays no media from a server that ignores Range).
 *  - `X-Content-Type-Options: nosniff` and a fixed Content-Type per extension.
 *  - `Cross-Origin-Resource-Policy: cross-origin` and
 *    `Access-Control-Allow-Origin: *`. The frame's origin is opaque, so to the
 *    browser EVERY request it makes is cross-origin: CORP `same-origin` /
 *    `same-site` would block its own images, classic scripts and styles, and
 *    module scripts and fonts are CORS requests that need ACAO. These files
 *    are public by design (no cookies, no auth, same bytes for everyone), so
 *    being readable cross-origin discloses nothing.
 *  - Fetch Metadata instead of CORP keeps the files from being used anywhere
 *    else (see `fetchMetadataRefusal`): HTML only as an iframe document, the
 *    rest never as a document or worker, and never requested by one of the
 *    app's OWN pages — the app's CSP allows `script-src 'self'`, so without
 *    this a plugin's JS on our origin would be a ready-made gadget for any
 *    HTML injection in the app. `Vary` names those headers.
 *  - `Cache-Control: public, max-age=31536000, immutable` for every file but
 *    the HTML: the version is in the path, only the active version is served,
 *    and their policy never names an approved origin (only a document's CSP
 *    governs the frame; a script's or an image's does not). The HTML is
 *    `no-cache`: its policy carries the approval, which can change for the
 *    same version (approved again, or taken back), so every load asks the
 *    server.
 *  - `CDN-Cache-Control: no-store` and `Cloudflare-CDN-Cache-Control:
 *    no-store` on every response: browsers keep caching as above, shared
 *    caches never store these. A CDN that ignores `Vary` (Cloudflare caches
 *    `.js` by extension) would otherwise hand the cached 200 to a request
 *    the Fetch Metadata check refuses — an app page asking for a plugin
 *    script (docs/DEPLOY_CLOUDFLARE.md).
 *  - No `X-Frame-Options` (it would forbid the frame; `frame-ancestors`
 *    governs), no cookies read or set, no auth: an opaque-origin frame sends
 *    no SameSite=Lax cookie, and installed plugin assets are not secret.
 *    The middleware and next.config skip this route so their app-wide
 *    `frame-ancestors 'none'` / `X-Frame-Options: DENY` are not appended,
 *    and the bundled nginx proxies it from its own location, without its
 *    server-wide `X-Frame-Options` (infra/nginx/conf.d/app.conf.template).
 */
import { constants as fsConstants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { isOfficialPluginId } from './official-plugin-ids';
import { effectiveApprovals } from './plugin-approvals';
import { isCspOrigin } from './plugin-frame-target';
import {
  PLUGIN_ID_RE,
  VERSION_RE,
  pluginInstallDir,
  readActivePointer,
  readInstalledSandboxManifest,
  type ActivePluginVersion,
} from './plugin-install-layout';
import type { SandboxManifest, SandboxNetwork, SandboxNetworkKind } from './sandbox-manifest';
import { resolveClientAddress } from './security-headers';

/**
 * Where a plugin version's files live, as a CSP source:
 * `https://chat.example.com/api/plugin-ui/<id>/<version>/`. A source ending
 * in `/` matches every path below it and nothing else, so `fetch()` and
 * `<audio>` reach this version's own files only — not the app's API, not
 * another plugin. The origin comes from configuration, never from the
 * request: the response is cached `public, immutable`, and a Host header
 * must not be able to write itself into a policy a shared cache hands to
 * everyone. Without a configured origin (a dev setup) it is `'self'`: the
 * app's origin, which the frame reaches without cookies (its origin is
 * opaque and every app cookie is SameSite=Lax) and where every mutating
 * route refuses a cross-site request.
 */
export function pluginUiAssetSource(
  pluginId: string,
  version: string,
  env: Record<string, string | undefined> = process.env
): string {
  for (const value of [env.LOBBYFORGE_APP_ORIGIN, env.NEXT_PUBLIC_BASE_URL]) {
    if (!value) continue;
    try {
      const { origin, protocol } = new URL(value);
      if (protocol === 'https:' || protocol === 'http:') return `${origin}/api/plugin-ui/${pluginId}/${version}/`;
    } catch {
      /* not a URL: try the next one */
    }
  }
  return "'self'";
}

/**
 * The frame document's policy: ADR-007's CSP plus `sandbox allow-scripts`,
 * and the outside origins in `network`. Pass only the plugin's EFFECTIVE
 * origins (`effectiveApprovals(manifest, active.approved).network`): asked
 * for by the manifest and approved by the owner. Anything that is not a
 * plain `scheme://host[:port]` is left out (`isCspOrigin`). Without
 * `network.frame` there is no `frame-src`, so `default-src 'none'` forbids
 * nested frames.
 */
export function pluginUiCsp(assetSource: string, network: SandboxNetwork = {}): string {
  const approved = (kind: SandboxNetworkKind): string[] => (network[kind] ?? []).filter(isCspOrigin);
  const plus = (kind: SandboxNetworkKind): string => approved(kind).map((origin) => ` ${origin}`).join('');
  const frames = approved('frame');
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${plus('img')}`,
    "font-src 'self'",
    `media-src ${assetSource} data: blob:${plus('media')}`,
    // An https origin here also admits wss:// to the same host (CSP level 3).
    `connect-src ${assetSource}${plus('connect')}`,
    ...(frames.length > 0 ? [`frame-src ${frames.join(' ')}`] : []),
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    // WebRTC is outside connect-src; this refuses it where the browser
    // implements the directive (others ignore it). See the header comment.
    "webrtc 'block'",
    'sandbox allow-scripts',
  ].join('; ');
}

/** For refusals: nothing loads, nothing frames it. */
const REFUSAL_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/**
 * Shared caches never store a plugin file or a refusal: a CDN that ignores
 * `Vary` would serve the cached answer to a request the Fetch Metadata check
 * refuses (or the reverse). Browser caching is untouched (`Cache-Control`).
 */
const CDN_NO_STORE: Readonly<Record<string, string>> = {
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
};

/** Belt and braces: the iframe has no `allow`, so these are off anyway. */
const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), display-capture=()';

type AssetKind = 'document' | 'script' | 'style' | 'data' | 'image' | 'font' | 'media';

/** The ONLY extensions served, each with a fixed type. */
export const PLUGIN_UI_TYPES: Readonly<Record<string, { contentType: string; kind: AssetKind }>> = {
  html: { contentType: 'text/html; charset=utf-8', kind: 'document' },
  js: { contentType: 'text/javascript; charset=utf-8', kind: 'script' },
  mjs: { contentType: 'text/javascript; charset=utf-8', kind: 'script' },
  css: { contentType: 'text/css; charset=utf-8', kind: 'style' },
  json: { contentType: 'application/json; charset=utf-8', kind: 'data' },
  png: { contentType: 'image/png', kind: 'image' },
  jpg: { contentType: 'image/jpeg', kind: 'image' },
  jpeg: { contentType: 'image/jpeg', kind: 'image' },
  gif: { contentType: 'image/gif', kind: 'image' },
  webp: { contentType: 'image/webp', kind: 'image' },
  // Only ever as an image (see fetchMetadataRefusal): scripts in an SVG do
  // not run in <img>, and the sandbox CSP still applies if opened directly.
  svg: { contentType: 'image/svg+xml', kind: 'image' },
  woff2: { contentType: 'font/woff2', kind: 'font' },
  woff: { contentType: 'font/woff', kind: 'font' },
  // Sound and video for <audio>/<video>, or fetched for the Web Audio API.
  mp3: { contentType: 'audio/mpeg', kind: 'media' },
  ogg: { contentType: 'audio/ogg', kind: 'media' },
  oga: { contentType: 'audio/ogg', kind: 'media' },
  opus: { contentType: 'audio/ogg', kind: 'media' },
  wav: { contentType: 'audio/wav', kind: 'media' },
  m4a: { contentType: 'audio/mp4', kind: 'media' },
  flac: { contentType: 'audio/flac', kind: 'media' },
  webm: { contentType: 'video/webm', kind: 'media' },
  mp4: { contentType: 'video/mp4', kind: 'media' },
  // WebAssembly and engine data (Godot's .pck, Unity's .data), read with fetch().
  wasm: { contentType: 'application/wasm', kind: 'data' },
  bin: { contentType: 'application/octet-stream', kind: 'data' },
  data: { contentType: 'application/octet-stream', kind: 'data' },
  pck: { contentType: 'application/octet-stream', kind: 'data' },
};

/** One path segment: letters, digits, `.`, `_`, `-`; no leading or trailing dot. */
const SEGMENT_RE = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;
const MAX_SEGMENTS = 12;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * The validated path segments, or null. Rejects empty paths, `.`/`..`,
 * hidden files, separators (`/`, `\`), NUL and every other character outside
 * the segment alphabet (so `:` drive letters and streams, `%`, spaces), and
 * any extension not in PLUGIN_UI_TYPES. Next has already percent-decoded each
 * segment, which is why a decoded `/` or `\` inside one is refused here.
 */
export function parsePluginUiPath(
  segments: unknown
): { segments: string[]; contentType: string; kind: AssetKind } | null {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > MAX_SEGMENTS) return null;
  for (const segment of segments) {
    if (typeof segment !== 'string' || !SEGMENT_RE.test(segment) || segment.includes('..')) return null;
  }
  const last = segments[segments.length - 1] as string;
  const dot = last.lastIndexOf('.');
  if (dot <= 0) return null;
  const type = PLUGIN_UI_TYPES[last.slice(dot + 1).toLowerCase()];
  if (!type) return null;
  return { segments: segments as string[], ...type };
}

const NAVIGATION_DESTS = new Set(['document', 'iframe', 'frame', 'nested-document', 'object', 'embed', 'fencedframe']);
const WORKER_DESTS = new Set(['worker', 'sharedworker', 'serviceworker']);

/**
 * Fetch Metadata policy. Returns a reason to refuse, or null to serve.
 * Browsers without Fetch Metadata send no `Sec-Fetch-Dest`; they are served,
 * and the sandbox CSP still holds.
 *
 *  - The HTML entry may only be an iframe's document: not a top-level page
 *    (a plugin page on the instance's own address could phish), not an
 *    <object>/<embed>, not read by fetch().
 *  - Nothing may run as a worker or service worker.
 *  - Everything else must come from the opaque frame — which the browser
 *    labels `cross-site` — never from one of the app's own pages
 *    (`same-origin`/`same-site`) and never as a document.
 */
export function fetchMetadataRefusal(req: Request, kind: AssetKind): string | null {
  const dest = req.headers.get('sec-fetch-dest')?.toLowerCase();
  if (!dest) return null;
  const site = req.headers.get('sec-fetch-site')?.toLowerCase() ?? '';
  if (WORKER_DESTS.has(dest)) return 'not a worker script';
  if (kind === 'document') {
    return dest === 'iframe' || dest === 'frame' ? null : 'only served as an iframe document';
  }
  if (NAVIGATION_DESTS.has(dest)) return 'not a document';
  if (site === 'same-origin' || site === 'same-site') return 'only served to the plugin frame';
  return null;
}

/**
 * A single `bytes=` range of a file of `size` bytes: `{ start, end }`
 * (inclusive), `'unsatisfiable'` for a range past the end, or null to send
 * the whole file (no header, several ranges, or anything malformed — a
 * server may always ignore Range).
 */
export function parseByteRange(
  header: string | null,
  size: number
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    // A suffix: the last N bytes.
    const length = Number(match[2]);
    if (length === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(match[1]);
  if (start >= size) return 'unsatisfiable';
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (end < start) return null;
  return { start, end };
}

const REFUSAL_TEXT = { 403: 'Forbidden\n', 404: 'Not found\n', 429: 'Too many requests\n' } as const;

function refusal(status: 403 | 404 | 429, method: string, retryAfterSeconds?: number): Response {
  return new Response(method === 'HEAD' ? null : REFUSAL_TEXT[status], {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Security-Policy': REFUSAL_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      ...CDN_NO_STORE,
      ...(retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {}),
    },
  });
}

/** The headers of every served file. Exported for the tests and the docs. */
export function pluginUiHeaders(contentType: string, kind: AssetKind, length: number, csp: string): Headers {
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Length': String(length),
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Allow-Origin': '*',
    // The document's policy names what the owner approved, which can change
    // for this version; every other file has the same bytes and headers forever.
    'Cache-Control': kind === 'document' ? 'no-cache' : 'public, max-age=31536000, immutable',
    ...CDN_NO_STORE,
    'Accept-Ranges': 'bytes',
    Vary: 'Sec-Fetch-Dest, Sec-Fetch-Site',
  });
  if (kind === 'image' && contentType === 'image/svg+xml') headers.set('Content-Disposition', 'inline');
  return headers;
}

/**
 * An installed version's manifest, read by the layout's own reader, which
 * validates the bundle exactly as the installer did (sdk "sandbox-v1",
 * matching id and version, server.js, ui/index.html when `ui: true`). Null
 * for a legacy or damaged bundle, which never gets a frame.
 */
export function readInstalledManifestOrNull(root: string, pluginId: string, version: string): SandboxManifest | null {
  try {
    return readInstalledSandboxManifest(root, pluginId, version);
  } catch {
    return null;
  }
}

/** Does this installed version serve a UI from its own files (`ui: true`)? */
export function installedVersionDeclaresUi(root: string, pluginId: string, version: string): boolean {
  return readInstalledManifestOrNull(root, pluginId, version)?.ui === true;
}

/**
 * Validated manifests of installed versions, keyed by install root, plugin,
 * version and the digest on its active record — the installer writes a new
 * digest whenever the files change, so an entry never outlives its bytes.
 * A bundle that failed validation is remembered for a short while only (a
 * transient read error must not hide a plugin for long). Bounded: the least
 * recently used entry goes first. Kept on `globalThis` (Next compiles this
 * module into several chunks; the installer's reset must reach the route's
 * copy — as in plugin-frame-origins.ts).
 */
interface ManifestCacheEntry {
  manifest: SandboxManifest | null;
  /** Epoch ms after which it is validated again (Infinity for a valid bundle). */
  expires: number;
}

export const PLUGIN_UI_MANIFEST_CACHE_MAX = 256;
const INVALID_BUNDLE_TTL_MS = 30_000;
const MANIFEST_CACHE_KEY = '__lobbyforgePluginUiManifests__';

function manifestCache(): Map<string, ManifestCacheEntry> {
  const holder = globalThis as typeof globalThis & { [MANIFEST_CACHE_KEY]?: Map<string, ManifestCacheEntry> };
  holder[MANIFEST_CACHE_KEY] ??= new Map();
  return holder[MANIFEST_CACHE_KEY];
}

/** Forget every validated manifest: the next request validates again. Called after an install. */
export function resetPluginUiAssetCache(): void {
  manifestCache().clear();
}

/** How many versions are cached (for the tests). */
export function pluginUiAssetCacheSize(): number {
  return manifestCache().size;
}

/** The active version's validated manifest, from the cache or read (and validated) once. */
function activeManifest(root: string, active: ActivePluginVersion, now: number): SandboxManifest | null {
  const cache = manifestCache();
  const key = `${root}\0${active.pluginId}@${active.version}#${active.digest}`;
  const hit = cache.get(key);
  cache.delete(key);
  if (hit && hit.expires > now) {
    cache.set(key, hit); // most recently used goes last
    return hit.manifest;
  }
  const manifest = readInstalledManifestOrNull(root, active.pluginId, active.version);
  cache.set(key, { manifest, expires: manifest ? Number.POSITIVE_INFINITY : now + INVALID_BUNDLE_TTL_MS });
  while (cache.size > PLUGIN_UI_MANIFEST_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return manifest;
}

/**
 * Per-address token bucket, in memory (no database, no Redis: the route must
 * stay cheap and up when they are not). Generous on purpose — a game's first
 * load can be hundreds of files, and a household or a LAN party shares one
 * address: a burst of PLUGIN_UI_RATE_BURST requests, refilled at
 * PLUGIN_UI_RATE_PER_SECOND. The address comes from the trusted proxy
 * setting (`resolveClientAddress`); without one every visitor shares one
 * bucket, as with every other limit (Admin → Health warns about it).
 */
export const PLUGIN_UI_RATE_BURST = 1000;
export const PLUGIN_UI_RATE_PER_SECOND = 50;
const MAX_RATE_BUCKETS = 10_000;
const RATE_BUCKETS_KEY = '__lobbyforgePluginUiRateBuckets__';

interface RateBucket {
  tokens: number;
  updated: number;
}

function rateBuckets(): Map<string, RateBucket> {
  const holder = globalThis as typeof globalThis & { [RATE_BUCKETS_KEY]?: Map<string, RateBucket> };
  holder[RATE_BUCKETS_KEY] ??= new Map();
  return holder[RATE_BUCKETS_KEY];
}

/**
 * Take one request from `address`'s bucket: 0 when allowed, otherwise the
 * seconds until a request is allowed again (for Retry-After). The least
 * recently seen address is dropped when the table is full, which can only
 * give that address a fresh burst.
 */
export function takePluginUiRequest(address: string, now: number = Date.now()): number {
  const buckets = rateBuckets();
  let bucket = buckets.get(address);
  if (bucket) {
    buckets.delete(address);
    const refill = (Math.max(0, now - bucket.updated) / 1000) * PLUGIN_UI_RATE_PER_SECOND;
    bucket.tokens = Math.min(PLUGIN_UI_RATE_BURST, bucket.tokens + refill);
    bucket.updated = now;
  } else {
    bucket = { tokens: PLUGIN_UI_RATE_BURST, updated: now };
    while (buckets.size >= MAX_RATE_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }
  buckets.set(address, bucket);
  if (bucket.tokens < 1) return Math.max(1, Math.ceil((1 - bucket.tokens) / PLUGIN_UI_RATE_PER_SECOND));
  bucket.tokens -= 1;
  return 0;
}

/** Forget every bucket (for the tests). */
export function resetPluginUiRateLimit(): void {
  rateBuckets().clear();
}

/** A file the route may serve, and what its document's policy may add. */
export interface ServablePluginUiFile {
  /** The real path, under the active version's `ui/`. */
  path: string;
  /** The plugin's effective outside origins: asked for by the manifest AND approved at install. */
  network: SandboxNetwork;
}

/**
 * A servable file, or null. Resolves under the ACTIVE version's `ui/`
 * folder and re-checks the real path (no symlink, no escape). The active
 * record is read on every request — the approval in it is what the
 * document's policy may add, and it can change for the same version — and
 * the manifest comes from the cache of validated versions.
 */
export async function resolvePluginUiFile(
  pluginId: string,
  version: string,
  segments: string[],
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now()
): Promise<ServablePluginUiFile | null> {
  if (env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED !== 'true') return null;
  if (!PLUGIN_ID_RE.test(pluginId) || !VERSION_RE.test(version)) return null;
  // A marketplace bundle can never take an official plugin's id.
  if (isOfficialPluginId(pluginId)) return null;
  const root = pluginInstallDir(env);
  const active = readActivePointer(root, pluginId);
  if (!active || active.version !== version) return null;
  const manifest = activeManifest(root, active, now);
  if (manifest?.ui !== true) return null;

  const uiDir = resolve(root, pluginId, version, 'ui');
  const candidate = resolve(uiDir, ...segments);
  if (!candidate.startsWith(uiDir + sep)) return null;
  try {
    const [realUi, realFile] = await Promise.all([realpath(uiDir), realpath(candidate)]);
    if (!realFile.startsWith(realUi + sep)) return null;
    return { path: realFile, network: effectiveApprovals(manifest, active.approved).network ?? {} };
  } catch {
    return null;
  }
}

/** Open a resolved file and read its size from the descriptor (no second lookup by name). */
async function openServable(path: string): Promise<{ handle: FileHandle; size: number } | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (info.isFile() && info.size <= MAX_FILE_BYTES) return { handle, size: info.size };
  } catch {
    /* refused below */
  }
  await handle.close().catch(() => undefined);
  return null;
}

/** `start`..`end` (inclusive) of an open file, streamed; the descriptor closes when the stream ends or is cancelled. */
function streamRange(handle: FileHandle, start: number, end: number): ReadableStream<Uint8Array> {
  return Readable.toWeb(handle.createReadStream({ start, end, autoClose: true })) as unknown as ReadableStream<Uint8Array>;
}

/** The whole route: GET and HEAD of /api/plugin-ui/{pluginId}/{version}/{...path}. */
export async function servePluginUiAsset(
  req: Request,
  params: { pluginId?: unknown; version?: unknown; path?: unknown },
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now()
): Promise<Response> {
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  // First, before any parsing or disk access: the cheap per-address limit.
  const retryAfter = takePluginUiRequest(resolveClientAddress(req), now);
  if (retryAfter > 0) return refusal(429, method, retryAfter);
  const parsed = parsePluginUiPath(params.path);
  if (!parsed || typeof params.pluginId !== 'string' || typeof params.version !== 'string') {
    return refusal(404, method);
  }
  // Before any disk access, so a refusal says nothing about what is installed.
  if (fetchMetadataRefusal(req, parsed.kind)) return refusal(403, method);

  const file = await resolvePluginUiFile(params.pluginId, params.version, parsed.segments, env, now);
  if (!file) return refusal(404, method);
  const opened = await openServable(file.path);
  if (!opened) return refusal(404, method);
  const { handle, size } = opened;
  // Only the document's policy governs the frame, so only the document names
  // the approved origins; every other file keeps the base policy and its
  // immutable caching.
  const csp = pluginUiCsp(
    pluginUiAssetSource(params.pluginId, params.version, env),
    parsed.kind === 'document' ? file.network : {}
  );
  const range = parseByteRange(req.headers.get('range'), size);
  if (range === 'unsatisfiable') {
    await handle.close();
    const headers = pluginUiHeaders(parsed.contentType, parsed.kind, 0, csp);
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = end - start + 1;
  const headers = pluginUiHeaders(parsed.contentType, parsed.kind, length, csp);
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  const status = range ? 206 : 200;
  // HEAD reads no body, and an empty file has none to read.
  if (method === 'HEAD' || length === 0) {
    await handle.close();
    return new Response(method === 'HEAD' ? null : new Uint8Array(0), { status, headers });
  }
  return new Response(streamRange(handle, start, end), { status, headers });
}
