/**
 * Next.js instrumentation boundary.
 *
 * Host schema migrations run before process start with
 * `pnpm -F @lobbyforge/db db:migrate`. Trusted component data migrations run
 * lazily at their first server-side use through the transaction/ledger runner.
 *
 * Do not import @lobbyforge/db (directly or indirectly) here. Next 15 builds
 * instrumentation for an Edge-compatible webpack target during development;
 * postgres.js then pulls in net/tls/crypto before any route can load.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  // security-review INFRA-V-02: refuse to start with a missing, short or
  // PUBLISHED session secret (the .env.example placeholder, the dev compose
  // default) — anyone could forge sessions against it. Only the local dev
  // stack (LOBBYFORGE_DEV_STACK=true, set by docker-compose.dev.yml) may run
  // with a placeholder. Thrown on purpose: `next start` exits on it.
  const { requireSessionSecret } = await import('@lobbyforge/core');
  try {
    requireSessionSecret();
  } catch (err) {
    console.error(`[App Boot] ${(err as Error).message}`);
    throw err;
  }

  // Pre-warm marketplace plugins: the active version recorded under
  // LOBBYFORGE_PLUGIN_INSTALL_DIR, loaded through the plugin-worker.
  // A no-op unless LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED=true.
  try {
    const { warmDynamicPlugins } = await import('./lib/plugin-server-registry');
    void warmDynamicPlugins().catch((err: unknown) =>
      console.error('[plugin-loader] boot warm failed:', (err as Error).message)
    );
  } catch {
    // Dynamic import may fail in some bundler configs — non-fatal.
  }

  if (process.env.LOBBYFORGE_BOOT_LOG === 'true') {
    console.log('[App Boot] LobbyForge web runtime initialized.');
  }
}
