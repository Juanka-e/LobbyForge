# 28 — CI/CD Pipeline

## Overview

LobbyForge uses GitHub Actions for continuous integration and delivery. The pipeline ensures code quality, runs tests, builds Docker images, and manages releases.

## Pipeline Architecture

```
Pull Request         Merge to main         Git Tag (vX.Y.Z)
    │                     │                      │
    ▼                     ▼                      ▼
┌─────────┐        ┌─────────────┐        ┌──────────────┐
│ PR Check │        │  Main Build  │        │   Release    │
│          │        │              │        │              │
│ • lint   │        │ • all PR     │        │ • all main   │
│ • type   │        │   checks     │        │   checks     │
│ • unit   │        │ • E2E tests  │        │ • Docker tag │
│ • integ  │        │ • Docker     │        │ • GH Release │
│ • build  │        │   build+push │        │ • Changelog  │
└─────────┘        └─────────────┘        └──────────────┘
```

## PR Check Workflow

```yaml
# .github/workflows/pr-check.yml
name: PR Check

on:
  pull_request:
    branches: [main, develop]

concurrency:
  group: pr-${{ github.head_ref }}
  cancel-in-progress: true

jobs:
  lint-and-type:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck

  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:unit

  integration-tests:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_DB: lobbyforge_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:integration
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/lobbyforge_test
          REDIS_URL: redis://localhost:6379

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
```

## Main Branch Workflow

```yaml
# .github/workflows/main.yml
name: Main Build

on:
  push:
    branches: [main]

jobs:
  # Include all PR check jobs, plus:

  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: npx playwright install --with-deps chromium
      - run: pnpm test:e2e
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/lobbyforge_test
          REDIS_URL: redis://localhost:6379
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: apps/web/playwright-report/

  docker-build:
    needs: [e2e-tests]
    runs-on: ubuntu-latest
    permissions:
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ghcr.io/lobbyforge/lobbyforge-web:latest
            ghcr.io/lobbyforge/lobbyforge-web:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

## Release Workflow

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      packages: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # full history for changelog

      # Run all checks...

      - name: Docker Build & Push
        uses: docker/build-push-action@v6
        with:
          push: true
          tags: |
            ghcr.io/lobbyforge/lobbyforge-web:${{ github.ref_name }}
            ghcr.io/lobbyforge/lobbyforge-web:latest

      - name: Generate Changelog
        id: changelog
        uses: mikepenz/release-changelog-builder-action@v5
        with:
          configuration: .github/changelog-config.json

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          body: ${{ steps.changelog.outputs.changelog }}
          generate_release_notes: true
```

## Dependency Management

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      production-deps:
        patterns:
          - "*"
        exclude-patterns:
          - "@types/*"
          - "eslint*"
          - "prettier*"
          - "vitest*"
          - "@playwright/*"
      dev-deps:
        patterns:
          - "@types/*"
          - "eslint*"
          - "prettier*"
          - "vitest*"
          - "@playwright/*"
    open-pull-requests-limit: 10

  - package-ecosystem: docker
    directory: /infra/docker
    schedule:
      interval: weekly

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

## Branch Strategy

```
main          ← production-ready, tagged releases
  └── develop ← integration branch
       ├── feature/xxx  ← feature branches
       ├── fix/xxx      ← bug fix branches
       └── docs/xxx     ← documentation branches
```

- Feature branches merge to `develop` via PR
- `develop` merges to `main` for releases
- Hotfixes: branch from `main`, merge to both `main` and `develop`
- Branch protection: require PR reviews, passing checks, up-to-date branch

## Docker Build

```dockerfile
# Dockerfile (multi-stage)
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/*/package.json ./packages/*/
RUN pnpm install --frozen-lockfile --prod=false

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

## Environment Variables in CI

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | GitHub Secrets | Test DB connection |
| `REDIS_URL` | GitHub Secrets | Test Redis connection |
| `GITHUB_TOKEN` | Auto-provided | GHCR push, release creation |
| `LIVEKIT_API_KEY` | GitHub Secrets | Test LiveKit token generation |
| `LIVEKIT_API_SECRET` | GitHub Secrets | Test LiveKit token generation |

## Local Development CI

Developers can run the full CI pipeline locally:

```bash
# Quick check (like PR)
pnpm lint && pnpm typecheck && pnpm test:unit

# Full check (like main)
pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build
```
