/**
 * Serving a marketplace plugin's UI to the lobby's sandboxed iframe (ADR-007,
 * "Client side"). The route is /api/plugin-ui/{pluginId}/{version}/{...path}
 * and maps to `<install root>/<pluginId>/<version>/ui/<path>`.
 *
 * What is served: files of the ACTIVE version (active.json, via
 * plugin-install-layout.ts) of an installed `sdk: "sandbox-v1"` bundle whose
 * manifest says `ui: true` — and only while dynamic plugins are enabled. Any
 * other version, plugin, path or extension is a 404. Nothing outside `ui/` is
 * reachable (server.js and manifest.json are not UI).
 *
 * The response headers are the security boundary, so every one is deliberate:
 *
 *  - CSP (the ADR's policy) plus `sandbox allow-scripts`. The iframe already
 *    has `sandbox="allow-scripts"`; repeating it in the CSP keeps the document
 *    in an opaque origin even when it is opened some other way (a link, a
 *    frame without the attribute), so a plugin page can never run as the app.
 *    `'self'`-only images/scripts/styles/fonts, and `fetch()` and media
 *    limited to the plugin's OWN files (see `pluginUiAssetSource`): no
 *    network to send anything to. `'wasm-unsafe-eval'` lets it compile
 *    WebAssembly, which reaches nothing a script cannot. `frame-ancestors
 *    'self'`: only the app's own pages can frame it.
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
 *  - `Cache-Control: public, max-age=31536000, immutable`: the version is in
 *    the path and only the active version is served.
 *  - No `X-Frame-Options` (it would forbid the frame; `frame-ancestors`
 *    governs), no cookies read or set, no auth: an opaque-origin frame sends
 *    no SameSite=Lax cookie, and installed plugin assets are not secret.
 *    The middleware and next.config skip this route so their app-wide
 *    `frame-ancestors 'none'` / `X-Frame-Options: DENY` are not appended.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  PLUGIN_ID_RE,
  VERSION_RE,
  pluginInstallDir,
  readActivePointer,
  readInstalledSandboxManifest,
} from './plugin-install-layout';

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

/** The frame document's policy: ADR-007's CSP plus `sandbox allow-scripts`. */
export function pluginUiCsp(assetSource: string): string {
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `media-src ${assetSource} data: blob:`,
    `connect-src ${assetSource}`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    'sandbox allow-scripts',
  ].join('; ');
}

/** For refusals: nothing loads, nothing frames it. */
const REFUSAL_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

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

function refusal(status: 403 | 404, method: string): Response {
  return new Response(method === 'HEAD' ? null : status === 404 ? 'Not found\n' : 'Forbidden\n', {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Security-Policy': REFUSAL_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
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
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
    Vary: 'Sec-Fetch-Dest, Sec-Fetch-Site',
  });
  if (kind === 'image' && contentType === 'image/svg+xml') headers.set('Content-Disposition', 'inline');
  return headers;
}

/**
 * Does this installed version declare a UI? The layout's own reader
 * validates the bundle exactly as the installer did (sdk "sandbox-v1",
 * matching id and version, server.js, ui/index.html when `ui: true`); a
 * legacy or damaged bundle never gets a frame.
 */
export function installedVersionDeclaresUi(root: string, pluginId: string, version: string): boolean {
  try {
    return readInstalledSandboxManifest(root, pluginId, version).ui === true;
  } catch {
    return false;
  }
}

/**
 * The absolute path of a servable file, or null. Resolves under the ACTIVE
 * version's `ui/` folder and re-checks the real path (no symlink, no escape).
 */
export async function resolvePluginUiFile(
  pluginId: string,
  version: string,
  segments: string[],
  env: Record<string, string | undefined> = process.env
): Promise<string | null> {
  if (env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED !== 'true') return null;
  if (!PLUGIN_ID_RE.test(pluginId) || !VERSION_RE.test(version)) return null;
  const root = pluginInstallDir(env);
  const active = readActivePointer(root, pluginId);
  if (!active || active.version !== version) return null;
  if (!installedVersionDeclaresUi(root, pluginId, version)) return null;

  const uiDir = resolve(root, pluginId, version, 'ui');
  const candidate = resolve(uiDir, ...segments);
  if (!candidate.startsWith(uiDir + sep)) return null;
  try {
    const [realUi, realFile] = await Promise.all([realpath(uiDir), realpath(candidate)]);
    if (!realFile.startsWith(realUi + sep)) return null;
    const info = await stat(realFile);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return realFile;
  } catch {
    return null;
  }
}

/** The whole route: GET and HEAD of /api/plugin-ui/{pluginId}/{version}/{...path}. */
export async function servePluginUiAsset(
  req: Request,
  params: { pluginId?: unknown; version?: unknown; path?: unknown },
  env: Record<string, string | undefined> = process.env
): Promise<Response> {
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  const parsed = parsePluginUiPath(params.path);
  if (!parsed || typeof params.pluginId !== 'string' || typeof params.version !== 'string') {
    return refusal(404, method);
  }
  // Before any disk access, so a refusal says nothing about what is installed.
  if (fetchMetadataRefusal(req, parsed.kind)) return refusal(403, method);

  const file = await resolvePluginUiFile(params.pluginId, params.version, parsed.segments, env);
  if (!file) return refusal(404, method);
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return refusal(404, method);
  }
  const csp = pluginUiCsp(pluginUiAssetSource(params.pluginId, params.version, env));
  const range = parseByteRange(req.headers.get('range'), body.byteLength);
  if (range === 'unsatisfiable') {
    const headers = pluginUiHeaders(parsed.contentType, parsed.kind, 0, csp);
    headers.set('Content-Range', `bytes */${body.byteLength}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    const part = body.subarray(range.start, range.end + 1);
    const headers = pluginUiHeaders(parsed.contentType, parsed.kind, part.byteLength, csp);
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${body.byteLength}`);
    return new Response(method === 'HEAD' ? null : new Uint8Array(part), { status: 206, headers });
  }
  const headers = pluginUiHeaders(parsed.contentType, parsed.kind, body.byteLength, csp);
  return new Response(method === 'HEAD' ? null : new Uint8Array(body), { status: 200, headers });
}
