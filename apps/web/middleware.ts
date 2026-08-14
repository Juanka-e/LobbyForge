import { NextResponse } from 'next/server';
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
export function middleware(request: NextRequest) {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const requestId = crypto.randomUUID().slice(0, 8);

  // Construct the CSP with the per-request nonce.
  const isProduction = process.env.NODE_ENV === 'production';
  const connectSources = process.env.LOBBYFORGE_CSP_CONNECT_SRC?.trim()
    || (isProduction
      ? "'self' wss:"
      : "'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*");

  // Also include configured LiveKit/WS URLs.
  const extraSources = new Set<string>();
  for (const value of [process.env.NEXT_PUBLIC_LIVEKIT_URL, process.env.NEXT_PUBLIC_WS_URL]) {
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
    `script-src 'self' 'nonce-${nonce}'${isProduction ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src ${fullConnect}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isProduction ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  const response = NextResponse.next({
    request: {
      headers: new Headers(request.headers),
    },
  });

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('x-nonce', nonce);
  response.headers.set('x-request-id', requestId);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
  if (isProduction) {
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  return response;
}

export const config = {
  // Run on all routes except static assets.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};
