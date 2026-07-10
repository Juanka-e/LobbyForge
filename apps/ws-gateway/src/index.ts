/**
 * Entry point for the LobbyForge WebSocket gateway.
 *
 * Run with `pnpm -F @lobbyforge/ws-gateway dev` (watch) or
 * `pnpm -F @lobbyforge/ws-gateway start` (after `pnpm -F ... build`).
 *
 * Listens on `WS_HOST`:`WS_PORT` (defaults `127.0.0.1:3001`) and
 * brokers browser-side subscriptions to the same Redis bus the
 * Next.js app publishes on. See `protocol.ts` for the wire format
 * and `docs/REALTIME.md` (M20-bis) for the architecture.
 */
export * from './protocol.js';

import { createGateway } from './server.js';

function main(): void {
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
