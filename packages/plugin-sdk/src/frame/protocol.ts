/**
 * Frame protocol v1: how the LobbyForge lobby (the PARENT) talks to a
 * marketplace plugin's UI (the FRAME). ADR-007, "Client side".
 *
 * Both sides import these types — the host's PluginFrame validates against
 * them and the frame client (`connect()` in ./client.ts) produces them — so
 * there is one definition of the wire format.
 *
 * Security model, in one paragraph: the frame is loaded from
 * `/api/plugin-ui/{pluginId}/{version}/index.html` into
 * `<iframe sandbox="allow-scripts">` (no `allow-same-origin`), and the asset
 * route's own CSP repeats `sandbox allow-scripts`. The frame therefore runs in
 * an OPAQUE origin: it cannot read the app's cookies, storage or DOM, and the
 * app's session cookie is not sent with its requests. Its CSP has
 * `connect-src 'none'` and only `'self'` images, so it has no network to send
 * anything to. Everything it knows arrives in the messages below, and the
 * state it is given is already PROJECTED for its viewer by the server — it
 * never sees more than that person could. Everything it can do is an `action`,
 * which the parent sends through the normal actions route with the viewer's
 * session, where the plugin's action policies apply.
 *
 * Every message is a plain JSON object with `lf: 1` and a `type`.
 *
 *   parent → frame   init   { viewer, players, locale, theme, state, revision }
 *                    state  { state, revision }
 *   frame → parent   ready
 *                    action { action }
 *                    resize { height }
 *
 * The frame sends `ready` when its script starts; the parent answers with
 * `init`. `init` may arrive again later — whenever the viewer's context
 * changes (players, language, theme) or the frame says `ready` again — so
 * handle it idempotently. `state` follows every change of the projected state.
 */

/** The `lf` field every message carries. */
export const FRAME_PROTOCOL_VERSION = 1 as const;

/** Largest message the parent accepts from a frame (UTF-8 bytes of its JSON). */
export const FRAME_MAX_MESSAGE_BYTES = 64 * 1024;

/** Actions the parent forwards per frame per second; extra ones are dropped. */
export const FRAME_MAX_ACTIONS_PER_SECOND = 10;

/** The parent clamps `resize` heights into this range (CSS pixels). */
export const FRAME_MIN_HEIGHT = 200;
export const FRAME_MAX_HEIGHT = 1200;

/** Longest action `type` the parent forwards. */
export const FRAME_MAX_ACTION_TYPE_LENGTH = 100;

/**
 * The host theme variables the parent copies into `init.theme.vars`, with
 * their current values for the viewer's theme (dark, dim or light) and
 * accent. The frame client sets them on the frame's `:root`, so a stylesheet
 * can use `var(--lf-surface, #111722)` exactly like an official panel.
 */
export const FRAME_THEME_VARIABLES = [
  '--lf-background',
  '--lf-page-bg',
  '--lf-surface',
  '--lf-surface-raised',
  '--lf-surface-container',
  '--lf-surface-container-high',
  '--lf-surface-dim',
  '--lf-border-subtle',
  '--lf-text-primary',
  '--lf-text-secondary',
  '--lf-text-muted',
  '--lf-user-accent',
  '--lf-on-accent',
  '--lf-ember',
  '--lf-on-ember',
  '--lf-success',
  '--lf-danger',
] as const;

export type FrameThemeVariable = (typeof FRAME_THEME_VARIABLES)[number];

/** Which of the app's themes the viewer uses. */
export type FrameColorScheme = 'dark' | 'dim' | 'light';

export interface FrameTheme {
  scheme: FrameColorScheme;
  /** `--lf-*` custom property → its current value, e.g. `'--lf-surface': '#111722'`. */
  vars: Record<string, string>;
}

/** The person looking at this frame. */
export interface FrameViewer {
  userId: string;
  /** True for the person who started the session. */
  isHost: boolean;
}

/** Someone the frame may need to name: the session roster plus the voice channel. */
export interface FramePlayer {
  userId: string;
  name: string | null;
  isHost: boolean;
}

/** What a frame may dispatch. The plugin's own `validateAction` checks the rest. */
export interface FrameAction {
  type: string;
  [key: string]: unknown;
}

// ---- parent → frame -------------------------------------------------------

export interface FrameInitMessage<TState = unknown> {
  lf: typeof FRAME_PROTOCOL_VERSION;
  type: 'init';
  viewer: FrameViewer;
  players: FramePlayer[];
  /** The app's language for this viewer (a BCP 47 tag such as `en` or `tr`). */
  locale: string;
  theme: FrameTheme;
  /** The state projected for `viewer` — never the plugin's full state. */
  state: TState;
  /** Increases with every state the parent sends. */
  revision: number;
}

export interface FrameStateMessage<TState = unknown> {
  lf: typeof FRAME_PROTOCOL_VERSION;
  type: 'state';
  state: TState;
  revision: number;
}

export type HostToFrameMessage<TState = unknown> = FrameInitMessage<TState> | FrameStateMessage<TState>;

// ---- frame → parent -------------------------------------------------------

export interface FrameReadyMessage {
  lf: typeof FRAME_PROTOCOL_VERSION;
  type: 'ready';
}

export interface FrameActionMessage<TAction extends FrameAction = FrameAction> {
  lf: typeof FRAME_PROTOCOL_VERSION;
  type: 'action';
  action: TAction;
}

export interface FrameResizeMessage {
  lf: typeof FRAME_PROTOCOL_VERSION;
  type: 'resize';
  /** The content height in CSS pixels; the parent clamps it. */
  height: number;
}

export type FrameToHostMessage = FrameReadyMessage | FrameActionMessage | FrameResizeMessage;

/** The height the parent gives a frame that asked for `height`. */
export function clampFrameHeight(height: number): number {
  if (!Number.isFinite(height)) return FRAME_MIN_HEIGHT;
  return Math.min(FRAME_MAX_HEIGHT, Math.max(FRAME_MIN_HEIGHT, Math.round(height)));
}
