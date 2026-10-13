/**
 * Entry point for the LobbyForge WebSocket gateway.
 *
 * Run with `pnpm -F @lobbyforge/ws-gateway dev` (watch) or
 * `pnpm -F @lobbyforge/ws-gateway start` (after `pnpm -F ... build`).
 *
 * Listens on `WS_HOST`:`WS_PORT` (defaults `0.0.0.0:19521`) and
 * brokers browser-side subscriptions to the same Redis bus the
 * Next.js app publishes on. See `protocol.ts` for the wire format
 * and `docs/REALTIME.md` (M20-bis) for the architecture.
 */
export * from './protocol.js';

import { requireSessionSecret } from '@lobbyforge/core';
import { createGateway } from './server.js';

function main(): void {
  // security-review INFRA-V-02: refuse to start with a missing, short or
  // published-placeholder session secret (only the local dev stack, with
  // LOBBYFORGE_DEV_STACK=true, may use one). Every handshake would verify
  // cookies against it.
  try {
    requireSessionSecret();
  } catch (err) {
    console.error(`[ws-gateway] ${(err as Error).message}`);
    process.exit(1);
  }
  const gateway = createGateway();
  const { wss } = gateway;
  const address = wss.address();
  if (address && typeof address === 'object') {
    console.info(`[ws-gateway] listening on ws://${address.address}:${address.port}`);
  }

  const shutdown = async (signal: string) => {
    console.info(`[ws-gateway] received ${signal}, shutting down`);
    await gateway.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
