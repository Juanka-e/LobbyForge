/**
 * Re-export of @lobbyforge/core cookie helpers. The canonical home for these
 * helpers is `@lobbyforge/core` so the ws-gateway can use the same code.
 */
export {
  signSessionCookie,
  verifySessionCookie,
  readCookie,
  clearCookieHeader,
  type SignOptions,
  type SignResult,
} from '@lobbyforge/core';