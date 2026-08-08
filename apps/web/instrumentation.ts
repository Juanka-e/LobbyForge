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

  // Pre-warm dynamically-loaded marketplace plugins from disk.
  // Safe no-op if plugins/installed/ doesn't exist or is empty.
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
