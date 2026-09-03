/**
 * LF-001: the canonical projector now lives in @lobbyforge/core so the
 * ws-gateway uses the SAME implementation (SEC-001). This re-export
 * keeps the existing web import paths stable.
 */
export { projectActivityState } from '@lobbyforge/core';
