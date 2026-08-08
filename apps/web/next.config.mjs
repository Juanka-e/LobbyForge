const isProduction = process.env.NODE_ENV === 'production';
function configuredConnectSources() {
  const sources = new Set(["'self'"]);
  for (const value of [process.env.NEXT_PUBLIC_LIVEKIT_URL, process.env.NEXT_PUBLIC_WS_URL]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) continue;
      sources.add(url.origin);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        const websocket = new URL(url.origin);
        websocket.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        sources.add(websocket.origin);
      }
    } catch {
      // Invalid public runtime URLs fail closed instead of entering the CSP.
    }
  }
  if (sources.size > 1) return [...sources].join(' ');
  return isProduction
    ? "'self' wss:"
    : "'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*";
}
const connectSources = process.env.LOBBYFORGE_CSP_CONNECT_SRC?.trim()
  || configuredConnectSources();
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages are consumed as source pointers; let Next transpile them
  // so the @lobbyforge/* package TS sources compile in the same step.
  transpilePackages: [
    '@lobbyforge/core',
    '@lobbyforge/i18n',
    '@lobbyforge/ui',
  ],
  // @lobbyforge/db is consumed as a runtime require() (not bundled) because
  // its query helpers lean on postgres.js which uses node:net internally.
  // Keeping the package external here is defense-in-depth: a future
  // contributor adding a node:* import to a query helper will not blow up
  // the build. The boot-time migrator (drizzle-orm/postgres-js/migrator)
  // was removed from the project entirely — it is a deployment concern
  // (see `pnpm -F @lobbyforge/db db:push`). The webpack edge resolver
  // cannot follow node:crypto / net / tls / stream imports, and adding
  // them to serverExternalPackages does not help for dynamic imports.
  // See docs/WEB_APP.md "Database migrations" for the full rationale.
  serverExternalPackages: ['@lobbyforge/db'],
  typedRoutes: true,
  async headers() {
    // Security headers (CSP is set per-request by middleware.ts with a nonce).
    const headers = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(), payment=()' },
    ];
    if (isProduction) {
      headers.push({
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload',
      });
    }
    return [{ source: '/:path*', headers }];
  },
};

export default nextConfig;
