/**
 * `@lobbyforge/plugin-sdk/frame` — for marketplace plugin UIs that run in the
 * lobby's sandboxed iframe (ADR-007).
 *
 *   import { connect } from '@lobbyforge/plugin-sdk/frame';
 *   const lf = connect({ onState: render });
 *   lf.dispatch({ type: 'buzz' });
 *
 * The frame runs in an opaque origin with no network (see ./protocol.ts for
 * the full security model). Dependency-free; the host imports the same
 * protocol types and limits.
 */
export { connect, type ConnectOptions, type FrameConnection, type FrameInit } from './client.js';
export {
  FRAME_MAX_ACTIONS_PER_SECOND,
  FRAME_MAX_ACTION_TYPE_LENGTH,
  FRAME_MAX_HEIGHT,
  FRAME_MAX_MESSAGE_BYTES,
  FRAME_MIN_HEIGHT,
  FRAME_PROTOCOL_VERSION,
  FRAME_THEME_VARIABLES,
  clampFrameHeight,
  type FrameAction,
  type FrameActionMessage,
  type FrameColorScheme,
  type FrameInitMessage,
  type FramePlayer,
  type FrameReadyMessage,
  type FrameResizeMessage,
  type FrameStateMessage,
  type FrameTheme,
  type FrameThemeVariable,
  type FrameToHostMessage,
  type FrameViewer,
  type HostToFrameMessage,
} from './protocol.js';
