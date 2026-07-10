/**
 * Re-export of @lobbyforge/core guest-session helpers. The canonical home is
 * `@lobbyforge/core` so the ws-gateway can use the same code without
 * depending on `apps/web`.
 */
export {
  GUEST_COOKIE_NAME,
  GUEST_SESSION_TTL_SECONDS,
  createGuestIdentity,
  buildGuestSessionCookie,
  readGuestSession,
  type GuestPayload,
  type GuestIdentity,
} from '@lobbyforge/core';