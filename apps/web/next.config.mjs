const isProduction = process.env.NODE_ENV === 'production';
const connectSources = process.env.LOBBYFORGE_CSP_CONNECT_SRC?.trim()
  || (isProduction
    ? "'self' wss:"
    : "'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*");
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  `connect-src ${connectSources}`,
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isProduction ? ['upgrade-insecure-requests'] : []),
].join('; ');

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
    const headers = [
      { key: 'Content-Security-Policy', value: contentSecurityPolicy },
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
