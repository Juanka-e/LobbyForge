# Voice Room UI — M14 / Phase 2 community MVP

The voice-room UI is the user-facing deliverable that closes Phase 1 of the roadmap — the "two browsers in the same room" success criterion. M14 ships the real LiveKit-driven UI at `/room/[roomName]`, replacing the developer-facing `/connect` page that the M9 work exposed.

This document covers:
- The `/room/[roomName]` page
- The `livekit-client` choice (no `@livekit/components-react`)
- The connect flow
- The self-mute / server-mute split
- The 5-second presence heartbeat
- The `NEXT_PUBLIC_LIVEKIT_URL` env var
- The relationship to M9 (`/api/livekit/token`)
- The out-of-scope list (server-side mute, screenshare, recording)

## The `/room/[roomName]` page

`apps/web/app/room/[roomName]/page.tsx` is a client component. On mount:

1. **Guest session.** Probes `GET /api/auth/guest` first; if 401, POSTs to mint a new identity. The rebind path lets a returning visitor keep their `gid` (which is also the LiveKit identity).
2. **LiveKit token.** `POST /api/livekit/token` with `{ room: roomName }`. The server signs a JWT with the user's `gid` as the identity and the cookie's display name as the participant name. The token TTL is 1 hour; the page's heartbeat keeps the LobbyForge-side presence alive, but the LiveKit token itself is the only thing that authorizes the WebSocket connect.
3. **`Room.connect`.** `new Room({ adaptiveStream: true, dynacast: true }).connect(NEXT_PUBLIC_LIVEKIT_URL, token)`. `adaptiveStream` tells LiveKit to throttle video quality on the server side based on the subscriber's viewport; `dynacast` tells the SFU to dynamically unsubscribe publishers from tracks nobody is watching. Both are server-side cost savers that don't change the wire format.
4. **Render.** The room name + connection state (from `RoomEvent.ConnectionStateChanged`) + a participant list (local + remote, with the "you" decoration on the local participant) + two buttons (mute, deafen).
5. **Heartbeat.** If the URL carries `?serverId=…&channelId=…`, the page posts a presence heartbeat every 5 seconds to `/api/servers/{serverId}/channels/{channelId}/presence`.

The connection state is rendered as a `<code>` tag with one of `connected / connecting… / reconnecting… / disconnected`. The participant list re-renders on `RoomEvent.ParticipantConnected`, `RoomEvent.ParticipantDisconnected`, and `RoomEvent.ActiveSpeakersChanged` (the last so the "speaking" badge updates as people talk).

### Bot participant metadata

Bot runners should join LiveKit with either a `bot:` identity prefix or
participant metadata that marks the participant as a bot:

```json
{
  "kind": "bot",
  "bot": true,
  "botType": "music",
  "trustLevel": "official",
  "publisher": "LobbyForge"
}
```

The room UI renders a `BOT` badge for these participants and shows the trust
level when provided. The hover title includes publisher and bot type so music,
game-host, narrator, and moderation bots are visually distinct from human
participants even before the full profile popover lands.

## The `livekit-client` choice

We use the vanilla `livekit-client` SDK instead of the React wrapper `@livekit/components-react`. The reasons:

- **Smaller dep surface.** `@livekit/components-react` pulls in `@livekit/components-core` + the React rendering layer + a lot of CSS that we don't need. The vanilla SDK is ~50 KB gzipped.
- **No DOM framework lock-in.** The web app is a thin shell today; we don't have a component library we want to be bound to. When the M15+ UI lands, we can re-evaluate.
- **The rendering is trivial.** The participant list is a `<ul>`. The connection state is a `<code>` tag. The mic / deafen buttons are `<button>`s with `onClick` handlers. None of that needs a custom component.

The M15 follow-up can swap to `@livekit/components-react` if the UI grows past the simple "list of participants + mic / deafen" surface.

## The connect flow

```
[Page Mount]
   ↓
GET /api/auth/guest (probe)
   ↓
401? → POST /api/auth/guest (mint identity)
   ↓
POST /api/livekit/token { serverId, channelId }
   ↓
new Room({ ... }).connect(NEXT_PUBLIC_LIVEKIT_URL, token)
   ↓
[LiveKit WebSocket open]
   ↓
[UI renders participant list + buttons]
   ↓
setInterval(5_000) → POST /api/servers/{serverId}/channels/{channelId}/presence
```

The page tears down on unmount: `room.disconnect()` + `clearInterval(heartbeat)`. The `useEffect` cleanup function handles both.

### Self-mute vs server-mute

M14 ships **self-mute** only. The mic button calls `localParticipant.setMicrophoneEnabled(!micEnabled)`. The local participant's track is unpublished from the room when mic is off — other participants stop receiving the audio immediately.

**Server-side mute** (M15.7) allows a moderator to force a noisy participant's mic off. This is implemented via a new endpoint `POST /api/servers/{id}/channels/{channelId}/members/{userId}/voice/mute`. It uses the `RoomServiceClient.mutePublishedTrack` method from the LiveKit Server SDK. Requires `MUTE_MEMBERS` permission.

### Stable User Identity (M15)

As of M15, the LiveKit participant identity is unified with the permanent `userId` (uid) from the database. This allows administrative actions (like muting or kicking) to target a specific user reliably across sessions, rather than relying on ephemeral guest IDs (gid).

### `NEXT_PUBLIC_LIVEKIT_URL`

The browser-side WebSocket URL. Read from `process.env.NEXT_PUBLIC_LIVEKIT_URL` at build time, defaults to `ws://localhost:7880` (the dev stack). Documented in `infra/docker/.env.example`.

The dev stack is `ws://` because the LiveKit dev server is plaintext; production is `wss://` behind a TLS-terminating proxy.

## The 90-second presence contract

See `docs/PRESENCE.md` for the full details. The relevant bit for the voice-room UI is the **5-second heartbeat** — fast enough that a participant dropping out (closing the tab, losing network) is reflected in the channel list within ~90 seconds, slow enough that a single dropped POST doesn't drop them out.

## Cross-platform

- `livekit-client` is a browser-only SDK; the page is `'use client'` and the LiveKit code only runs in the browser. No SSR / `node:` imports.
- The `NEXT_PUBLIC_LIVEKIT_URL` env var is browser-visible by convention; the API secret stays server-side in `LIVEKIT_API_SECRET` (consumed by `/api/livekit/token`).

## Tests

The voice-room UI is not unit-tested. The `apps/web` test suite is route-layer coverage; the React component tree is M15's responsibility. The `/connect` (developer surface) page has no tests either; it's a thin shell that exercises the same routes the voice-room UI exercises.

## Out of scope

- **Server-side mute / deafen.** See above. `livekit-server-sdk` + `RoomServiceClient` is M15.
- **Screenshare.** LiveKit supports it (`localParticipant.setScreenShareEnabled`); the UI lands with M15.
- **Recording / egress.** The `recorder: true` grant is already in the M9 token issuer. A "start recording" button + the recording storage pipeline is M15+.
- **Camera (video).** The token issuer already allows `canPublishSources: ['camera', ...]`. The video tile is M15.
- **Active speaker detection.** The vanilla `livekit-client` exposes `RoomEvent.ActiveSpeakersChanged`; we render a "speaking" badge on the participant list. The "this person is speaking, raise their tile" UX is M15.
- **Noise suppression / echo cancellation.** Browser-native, configured per-track. Today's defaults are fine for a test room; the M15 voice polish pass can tune them.
- **Per-room user limits.** A "this room is full" 4xx is M15.
- **Multi-room navigation.** The page is a single room. A "switch rooms" UI is M15.
- **WebRTC stats overlay.** Latency / packet-loss debug overlay is a debug feature; M15+.
- **Mobile layout.** The page uses inline CSS that adapts to a 14" laptop. A mobile layout (sidebar collapses, controls float) is M15.
- **Push-to-talk.** The mic toggle is a click-to-mute; a "hold spacebar to talk" is M15.
- **The `/servers/{id}` page.** The voice-room UI is reachable via a `roomName` URL parameter, but a real server home (with the channel list, member list, and a button to enter a voice channel) is M15 UI. The `/join/{code}` page links to `/servers/{id}` which 404s today.

## Security Hardening Update

Current LiveKit join behavior:

- The client posts `{ serverId, channelId }` to `/api/livekit/token`; it no
  longer chooses an arbitrary LiveKit room name.
- The token endpoint verifies server membership, channel ownership, voice/stage
  channel type, and `CONNECT_VOICE`.
- The server derives the LiveKit room name from `serverId + channelId`.
- The LiveKit participant identity is the local `uid`, matching roles, bans,
  memberships, and moderation actions.
- `/room/[roomName]` now needs `serverId` and `channelId` query params to
  connect securely.
