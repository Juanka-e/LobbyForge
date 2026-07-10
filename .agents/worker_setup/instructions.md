# Project Setup Instructions

Your task is to update `PROJECT.md` and `TEST_INFRA.md` at the root of the LobbyForge workspace (`d:/livekittest`) to define the Core Community MVP features, milestones, architecture, and testing scope.

## 1. Update `PROJECT.md`
Please update the milestones table in `PROJECT.md`:
- Set M6 (Cross-Platform Scripts) and M7 (Documentation & Verification) status to `DONE`.
- Append the following new milestones for the Core Community MVP:
  - **M8**: Automated Database Migrations & API Integration (R1) - Status: `PLANNED`
  - **M9**: Redis Real-time Presence (R4) - Status: `PLANNED`
  - **M10**: LiveKit Audio Streaming (R3) - Status: `PLANNED`
  - **M11**: Next.js Dashboard UI Layout (R2) - Status: `PLANNED`
  - **M12**: Integration, Verification & Documentation (R5) - Status: `PLANNED`
- Under `## Architecture`, append an `### MVP Architecture Extensions` section detailing:
  - **Stateless Session Validation**: Next.js auth utilizes encrypted/signed session cookies (`lf_guest`) to authenticate room requests.
  - **WebRTC Voice Stream Topology**: Next.js serves tokens using `jose`. The client connects directly to the LiveKit server with `livekit-client`.
  - **Ephemeral Store**: User presence status is stored in Redis under short-lived keys, maintaining a real-time list of who is in what voice channel.

## 2. Update `TEST_INFRA.md`
Please update `TEST_INFRA.md` to include:
- A new section `## MVP Integration Testing Framework`.
- A feature testing scope detailing:
  1. **Database & Migrations**: Test programmatic migrator resilience and database queries.
  2. **Redis Presence Service**: Unit tests checking setting, getting, and expiry of presence keys (e.g. using a mock Redis or local Redis).
  3. **LiveKit Integration**: Token generation verification and error handling.
- E2E Testing Scenarios: Multiple concurrent browser sessions creating guest sessions, joining same rooms, and asserting presence synchronization.

## Verification
- Ensure that you do not break the formatting of the existing sections.
- Verify the files after editing to make sure they are correct.
- Provide a summary of the edits made and confirm the paths in your handoff report.
