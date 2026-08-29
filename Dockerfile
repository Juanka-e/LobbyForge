FROM node:22-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app

COPY . .
# Fixed store dir so the runtime stage can reuse the cache offline.
RUN pnpm install --frozen-lockfile --store-dir /pnpm-store

ARG NEXT_PUBLIC_LIVEKIT_URL=http://localhost:7880
ARG NEXT_PUBLIC_WS_URL=ws://localhost:3001
ENV NEXT_PUBLIC_LIVEKIT_URL=$NEXT_PUBLIC_LIVEKIT_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NODE_ENV=production

# Build only the server-side packages (web, ws-gateway, db, core, etc).
# Skip desktop (Tauri needs Rust) and plugins that are consumed as source.
RUN pnpm --filter @lobbyforge/config build && \
    pnpm --filter @lobbyforge/core build && \
    pnpm --filter @lobbyforge/plugin-sdk build && \
    pnpm --filter @lobbyforge/bot-sdk build && \
    pnpm --filter @lobbyforge/db build && \
    pnpm --filter @lobbyforge/i18n build && \
    pnpm --filter @lobbyforge/ui build && \
    pnpm --filter @lobbyforge/registry build && \
    pnpm --filter @lobbyforge/ws-gateway build && \
    pnpm --filter @lobbyforge/web build

FROM node:22-bookworm-slim AS runtime

# PostgreSQL client tools for lfctl backup create/restore (pg_dump, pg_restore, psql)
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*

# The base image's bundled npm is unused (corepack + pnpm only) and its
# dependency manifests ship vulnerable tar versions (CVE-2026-59873).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /pnpm-store /pnpm-store
COPY --from=builder /app /app

# Strip devDependencies from the RUNTIME image (Trivy CRITICAL gate:
# vitest/happy-dom/tar CVEs were shipping because the builder's full
# node_modules was copied). `pnpm prune` proved pathologically slow in
# CI (>1h); instead rebuild node_modules PROD-ONLY, offline, from the
# store the builder already populated — same lockfile, no network.
# Workspace symlinks (@lobbyforge/db etc.) are recreated against the
# packages' built dist/, which the COPY above preserved.
# Remove EVERY node_modules (root AND per-package — the builder copy
# leaves nested ones with dev-only transitive deps like tar@7.4.3).
RUN find /app -name node_modules -type d -prune -exec rm -rf {} +     && pnpm install --prod --frozen-lockfile --offline --ignore-scripts --store-dir /pnpm-store

# Run as non-root — the node image ships with a `node` user (uid 1000).
RUN chown -R node:node /app
USER node

EXPOSE 3000 3001

# Start only the Next.js web server. The ws-gateway runs as a separate
# Docker Compose service with its own CMD override.
CMD ["pnpm", "--filter", "@lobbyforge/web", "start"]
