import { NextResponse } from 'next/server';
import { refreshedSessionCookie } from '@/lib/session-refresh';
import type { NextRequest } from 'next/server';

/**
 * CSP nonce middleware — generates a per-request nonce and attaches it
 * to the response headers so the CSP policy can reference 'nonce-xxx'
 * instead of 'unsafe-inline' for script-src.
 *
 * Next.js automatically reads the `x-nonce` response header and injects
 * it into <Script> tags and inline scripts when the CSP contains
 * 'nonce-{{nonce}}' — but we handle the CSP construction ourselves in
 * next.config.mjs via the headers() function, so we pass the nonce
 * through the `Content-Security-Policy` header directly here.
 */
/**
 * Marketplace plugin UI (ADR-007): `/api/plugin-ui/{pluginId}/{version}/…`
 * answers with its OWN policy — CSP `sandbox allow-scripts`, no network,
 * `frame-ancestors 'self'` — so the lobby can frame it. Next APPENDS a route
 * handler's headers to the ones set here (next/dist/server/send-response.js)
 * and a browser enforces every CSP it receives, so the app's
 * `frame-ancestors 'none'` and `X-Frame-Options: DENY` would forbid the
 * frame. That route therefore gets nothing from this middleware. Only the
 * exact route shape is skipped; anything else under the prefix is a 404 page
 * that keeps the app policy.
 */
const PLUGIN_UI_ROUTE = /^\/api\/plugin-ui\/[^/]+\/[^/]+\/[^/]/;

/**
 * Bot protection (docs/CAPTCHA.md §9): while an external CAPTCHA provider
 * (Turnstile, reCAPTCHA) is configured, its origins go on EVERY page
 * response — a client-side navigation keeps the CSP of the document it
 * started on, so adding them only to the widget pages would block the
 * widget after a `next/link` hop. Nothing is added for ALTCHA or `none`.
 * `lib/captcha/csp.ts` decides, from the 5 s settings cache this (Node.js
 * runtime) middleware shares with the routes. API routes and static files
 * never load that module.
 */
async function captchaSources(pathname: string): Promise<{ script: string[]; frame: string[]; connect: string[] }> {
  const empty = { script: [], frame: [], connect: [] };
  if (pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/_next/')) return empty;
  try {
    const { captchaCspSourcesForPath } = await import('@/lib/captcha/csp');
    return await captchaCspSourcesForPath(pathname);
  } catch (error) {
    console.error('[csp] captcha sources unavailable', (error as Error).message);
    return empty;
  }
}

/** A file name at the end of the path (`/icon.svg`): a static file, not a page. */
const FILE_PATH = /\/[^/]*\.[A-Za-z0-9]+$/;

/**
 * Marketplace plugins whose UI is their author's own site (`ui: { url }`,
 * docs/PLUGIN_UNLOCK_PLAN.md phase 2): the lobby frames that site, so its
 * origin joins the pages' `frame-src` — only while the instance owner's
 * approval is on the plugin's active record. On every page, for the same
 * reason as the CAPTCHA origins: a client-side navigation keeps the CSP of
 * the document it started on. `lib/plugin-frame-origins.ts` keeps the list
 * in a 30 s per-process cache read from the install root (reset by an
 * install), so a page costs a lookup in memory. Fail closed: when dynamic
 * plugins are off, for API routes and static files, and on any error,
 * nothing is added — the module is not even loaded.
 */
async function pluginFrameSources(pathname: string, requestOrigin: string): Promise<string[]> {
  if (process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED !== 'true') return [];
  if (pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/_next/') || FILE_PATH.test(pathname)) {
    return [];
  }
  try {
    const { approvedPluginFrameOrigins } = await import('@/lib/plugin-frame-origins');
    return approvedPluginFrameOrigins(requestOrigin);
  } catch (error) {
    console.error('[csp] plugin frame origins unavailable', (error as Error).message);
    return [];
  }
}

/**
 * Pages whose URL can carry a one-time token from an email — the
 * verification link, the password-reset link (docs/EMAIL.md §4.1, §4.3) —
 * send no Referer at all, not even to this origin. The pages also carry
 * `<meta name="referrer" content="no-referrer">` from their metadata.
 */
const NO_REFERRER_PAGES = new Set(['/verify-email', '/reset-password', '/forgot-password']);

const withSources = (sources: string[]) => (sources.length > 0 ? ` ${sources.join(' ')}` : '');

export async function proxy(request: NextRequest) {
  if (PLUGIN_UI_ROUTE.test(request.nextUrl.pathname)) return NextResponse.next();
  // The raw path: `nextUrl` rewrites `/_next/data/…` requests to the page they
  // belong to, and those are data, not documents.
  const rawUrl = new URL(request.url);
  const [captcha, pluginFrames] = await Promise.all([
    captchaSources(rawUrl.pathname),
    pluginFrameSources(rawUrl.pathname, rawUrl.origin),
  ]);

  const nonce = crypto.randomUUID().replace(/-/g, '');
  const requestId = crypto.randomUUID().slice(0, 8);

  // Construct the CSP with the per-request nonce.
  const isProduction = process.env.NODE_ENV === 'production';
  const connectSources = process.env.LOBBYFORGE_CSP_CONNECT_SRC?.trim()
    || (isProduction
      ? "'self' wss:"
      : "'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*");

  // Also include the configured LiveKit/WS URLs. beta-review: read with a
  // computed key so the value comes from the RUNTIME environment — a
  // published image is built without NEXT_PUBLIC_* and would otherwise
  // hand out a CSP that blocks the instance's own media endpoints.
  const publicEndpoint = (name: string) => process.env[name]?.trim() || undefined;
  const extraSources = new Set<string>();
  for (const value of [
    publicEndpoint('LOBBYFORGE_PUBLIC_LIVEKIT_URL') ?? publicEndpoint(['NEXT_PUBLIC', 'LIVEKIT_URL'].join('_')),
    publicEndpoint('LOBBYFORGE_PUBLIC_WS_URL') ?? publicEndpoint(['NEXT_PUBLIC', 'WS_URL'].join('_')),
  ]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      extraSources.add(url.origin);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        const ws = new URL(url.origin);
        ws.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        extraSources.add(ws.origin);
      }
    } catch {
      // skip invalid
    }
  }
  const fullConnect = extraSources.size > 0
    ? `'self' ${[...extraSources].join(' ')}`
    : connectSources;

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${withSources(captcha.script)}${isProduction ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src ${fullConnect}${withSources(captcha.connect)}`,
    // 'self': marketplace plugin UIs, served by /api/plugin-ui into
    // <iframe sandbox="allow-scripts"> (ADR-007) — opaque origin, own CSP.
    // Every app page refuses to be framed (frame-ancestors 'none' below), so
    // 'self' admits nothing else. This also bounds where a plugin frame can
    // navigate itself: the parent's frame-src governs those navigations.
    // Watch Party embeds YouTube's privacy-enhanced player (docs/WATCH_PARTY.md).
    // Exactly ONE third-party origin — no scheme wildcard, no youtube.com, no
    // *.youtube…. This grants framing only: no script, style or connection
    // from that origin runs in our page — the player lives in its own origin
    // and is driven over postMessage, checked both ways.
    // + the active external CAPTCHA provider's frame origins, on pages, only
    // while Turnstile or reCAPTCHA is configured (docs/CAPTCHA.md §9).
    // + the owner-approved sites of marketplace plugins whose UI is their
    // author's own page (pluginFrameSources above), on pages: framing only,
    // like YouTube's — the lobby's PluginFrame sandboxes them and talks to
    // each over postMessage checked against its origin.
    "frame-src 'self' https://www.youtube-nocookie.com" + withSources(captcha.frame) + withSources(pluginFrames),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isProduction ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  // 15th-audit: propagate the nonce AND CSP to the RENDERER via the
  // request headers — Next.js reads `x-nonce` and `Content-Security-
  // Policy` from the REQUEST during rendering to inject nonces into
  // framework scripts and inline bootstrap scripts. The old code only
  // set them on the response; the renderer never saw the nonce, so
  // production hydration could break under strict CSP.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('x-nonce', nonce);
  response.headers.set('x-request-id', requestId);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set(
    'Referrer-Policy',
    NO_REFERRER_PAGES.has(request.nextUrl.pathname) ? 'no-referrer' : 'strict-origin-when-cross-origin'
  );
  response.headers.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
  if (isProduction) {
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  // The sliding session on page loads (lib/session-refresh.ts). API routes
  // refresh in withApiSecurity, which sees the answer — a sign-out must not
  // get its cleared cookie overwritten here.
  if (!rawUrl.pathname.startsWith('/api/')) {
    const refreshed = refreshedSessionCookie(request.headers.get('cookie'));
    if (refreshed) response.headers.append('Set-Cookie', refreshed);
  }

  return response;
}

export const config = {
  // A proxy always runs in the Node.js runtime (Next 16; a `runtime` option
  // here is an error): the CAPTCHA CSP reads the instance settings, which
  // needs the database client and the process-wide settings cache the route
  // handlers fill.
  // Run on all routes except static assets.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};
