# LobbyForge Core Community MVP Implementation Plan

This plan outlines the steps, modules, and verification criteria for implementing the Core Community MVP features in the LobbyForge monorepo.

## Objectives
1. **Database Integration and Migration Automation (R1)**: Connect Next.js app to PostgreSQL with Drizzle ORM, run/apply migrations automatically on boot/build, and update API routes.
2. **Next.js Dashboard UI Layout (R2)**: Build the main dashboard frame using `@lobbyforge/ui` components with left navigation dock, server channel sidebar (separating voice/text), and chat/room section.
3. **LiveKit Audio Streaming (R3)**: Hook client voice channel selection to join a LiveKit session with microphone toggle, participants list, speaking indicators, and disconnect.
4. **Redis Real-time Presence (R4)**: Synchronize user presence (server/channel they are in) dynamically in Redis.
5. **Documentation & Validation (R5)**: Update documentation in `docs/` and verify the entire implementation via `pnpm verify` and production build.

## Decomposition & Milestones

| Milestone | Target Area | Description | Verification Method |
|-----------|-------------|-------------|---------------------|
| **M1: Database & Migrations** | `packages/db`, `apps/web` | Run Drizzle migrations on boot in `apps/web`, hook up real db connections to queries. | Unit tests + docker DB validation. |
| **M2: Redis Presence** | `packages/core`, `apps/web` | Implement Redis state store for presence (user location mapping) and API endpoints. | Redis presence test suite. |
| **M3: LiveKit Integration** | `apps/web` | Client voice connection to LiveKit, token generation validation, voice controls. | LiveKit connection mock tests. |
| **M4: Dashboard UI Layout** | `apps/web`, `@lobbyforge/ui` | Dashboard frame, navigation dock, server channel list sidebar, main area. | Next.js build + components test. |
| **M5: Integration & Verification** | Entire monorepo | End-to-end testing, documentation, `pnpm verify`, build. | `pnpm verify` + E2E test suite. |

## Implementation Strategy
- **Direct Iteration Loop**: For each milestone, we will dispatch work using the Explorer → Worker → Reviewer → Gate pattern.
- **Dual Track**: We will spawn an E2E testing track in parallel to design and implement a comprehensive opaque-box test suite.
- **Forensic Audit**: Each iteration will run a Forensic Audit to verify implementation integrity.
