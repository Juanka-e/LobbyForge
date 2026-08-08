FROM node:22-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile

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

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app /app

EXPOSE 3000 3001

# Start both the Next.js web server and the WebSocket gateway.
# The gateway runs in the background; the web server is the foreground process.
CMD ["sh", "-c", "node apps/ws-gateway/dist/index.js & pnpm --filter @lobbyforge/web start"]
