/**
 * The frame client: the plugin author's side of frame protocol v1.
 *
 *   import { connect } from '@lobbyforge/plugin-sdk/frame';
 *
 *   const lf = connect({
 *     onInit: ({ viewer, players, locale }) => { me = viewer; names = players; },
 *     onState: (state) => render(state),
 *   });
 *   button.onclick = () => lf.dispatch({ type: 'buzz' });
 *
 * What it does for you:
 *  - the handshake: says `ready` (and again every 250 ms until the parent
 *    answers, so a slow parent never leaves the frame blank);
 *  - applies the host theme: every `--lf-*` variable lands on `:root`, plus
 *    `data-lf-theme="dark|dim|light"`, `color-scheme` and `lang`;
 *  - auto-resize: a ResizeObserver reports the content height, so the frame
 *    is as tall as what it shows (the parent clamps it to 200–1200 px);
 *  - only listens to its parent window, on the frame's own host.
 *
 * Security model: this runs inside `<iframe sandbox="allow-scripts">` with an
 * opaque origin and a CSP of `connect-src 'none'` — no cookies, no storage of
 * the app, no network. All the frame learns is what the parent posts (the
 * state already projected for this viewer); all it can do is `dispatch`, which
 * the parent sends through the actions route as the viewer, under the plugin's
 * action policies. Do not try to fetch anything: it is blocked by design.
 *
 * This file has no runtime imports, so it also works copied verbatim into a
 * plugin's `ui/` folder (examples/plugins/sandbox-buzzer/ui/lobbyforge-frame.js
 * is exactly that, checked by a test).
 */
import type * as Protocol from './protocol.js';
import type {
  FrameAction,
  FrameColorScheme,
  FramePlayer,
  FrameTheme,
  FrameToHostMessage,
  FrameViewer,
} from './protocol.js';

const LF: typeof Protocol.FRAME_PROTOCOL_VERSION = 1;
const READY_RETRY_MS = 250;
const READY_RETRY_LIMIT = 40;
const THEME_VARIABLE_RE = /^--lf-[a-z0-9-]{1,64}$/;
const MAX_THEME_VALUE_LENGTH = 200;

/** What `onInit` receives: everything in the parent's `init` message. */
export interface FrameInit<TState = unknown> {
  viewer: FrameViewer;
  players: FramePlayer[];
  locale: string;
  theme: FrameTheme;
  state: TState;
  revision: number;
}

export interface ConnectOptions<TState = unknown> {
  /**
   * The parent's `init`: who is looking, who is playing, language, theme and
   * the first state. Called again whenever any of that changes.
   */
  onInit?: (init: FrameInit<TState>) => void;
  /**
   * The projected state, right after every `onInit` and on every change.
   * One render function here is enough for most frames.
   */
  onState?: (state: TState, revision: number) => void;
  /**
   * Report the content height automatically (default `true`, measuring
   * `document.body`). Pass an element to measure that instead, or `false` to
   * call `resize()` yourself.
   */
  autoResize?: boolean | Element;
  /** Apply the host theme variables to `:root` (default `true`). */
  applyTheme?: boolean;
  /** The frame's window. Only tests pass this. */
  window?: Window;
}

export interface FrameConnection<TAction extends FrameAction = FrameAction> {
  /** Ask the host to run an action as the viewer. Throws on a non-JSON action or a missing `type`. */
  dispatch(action: TAction): void;
  /** Tell the host how tall the frame's content is, in CSS pixels. */
  resize(height: number): void;
  /** True once the parent's first `init` has arrived. */
  readonly connected: boolean;
  /** Stop listening, observing and retrying. */
  close(): void;
}

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Where messages to the parent go. The asset route only lets the app's own
 * pages frame it (`frame-ancestors 'self'`), so the parent is on the frame
 * URL's host; `location.origin` is that URL's origin even though the frame's
 * own origin is opaque.
 */
function parentOrigin(win: Window): string {
  try {
    const origin = win.location.origin;
    if (origin.startsWith('http://') || origin.startsWith('https://')) return origin;
  } catch {
    // Fall through.
  }
  return '*';
}

function toScheme(value: unknown): FrameColorScheme {
  return value === 'light' || value === 'dim' ? value : 'dark';
}

function readTheme(value: unknown): FrameTheme {
  const vars: Record<string, string> = {};
  if (isObject(value) && isObject(value.vars)) {
    for (const [name, v] of Object.entries(value.vars)) {
      if (THEME_VARIABLE_RE.test(name) && typeof v === 'string' && v.length <= MAX_THEME_VALUE_LENGTH) {
        vars[name] = v;
      }
    }
  }
  return { scheme: toScheme(isObject(value) ? value.scheme : undefined), vars };
}

function readPlayers(value: unknown): FramePlayer[] {
  if (!Array.isArray(value)) return [];
  const players: FramePlayer[] = [];
  for (const p of value) {
    if (!isObject(p) || typeof p.userId !== 'string') continue;
    players.push({
      userId: p.userId,
      name: typeof p.name === 'string' ? p.name : null,
      isHost: p.isHost === true,
    });
  }
  return players;
}

function readViewer(value: unknown): FrameViewer {
  if (!isObject(value)) return { userId: '', isHost: false };
  return { userId: typeof value.userId === 'string' ? value.userId : '', isHost: value.isHost === true };
}

function applyThemeTo(doc: Document, theme: FrameTheme, locale: string): void {
  const root = doc.documentElement;
  if (!root) return;
  for (const [name, value] of Object.entries(theme.vars)) root.style.setProperty(name, value);
  root.setAttribute('data-lf-theme', theme.scheme);
  root.style.setProperty('color-scheme', theme.scheme === 'light' ? 'light' : 'dark');
  if (locale) root.setAttribute('lang', locale);
}

/** Height of `el` including its vertical margins, rounded up. */
function measure(win: Window, el: Element): number {
  const rect = el.getBoundingClientRect();
  let margins = 0;
  try {
    const style = win.getComputedStyle(el);
    margins = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
  } catch {
    margins = 0;
  }
  return Math.ceil(rect.height + margins);
}

/** Connect this frame to the LobbyForge parent. Call it once, when the script starts. */
export function connect<TState = unknown, TAction extends FrameAction = FrameAction>(
  options: ConnectOptions<TState> = {}
): FrameConnection<TAction> {
  const win = options.window ?? window;
  const doc = win.document;
  const parent = win.parent;
  const embedded = Boolean(parent) && parent !== win;
  const targetOrigin = parentOrigin(win);
  const applyTheme = options.applyTheme !== false;

  let connected = false;
  let closed = false;
  let lastHeight = -1;
  let readyTries = 0;
  let readyTimer: number | null = null;
  let measureQueued = false;
  let observer: ResizeObserver | null = null;
  let observed: Element | null = null;

  const post = (message: FrameToHostMessage): void => {
    if (!embedded || closed) return;
    parent.postMessage(message, targetOrigin);
  };

  const stopReady = (): void => {
    if (readyTimer !== null) {
      win.clearInterval(readyTimer);
      readyTimer = null;
    }
  };

  const resize = (height: number): void => {
    if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) return;
    const rounded = Math.ceil(height);
    if (rounded === lastHeight) return;
    lastHeight = rounded;
    post({ lf: LF, type: 'resize', height: rounded });
  };

  const measureNow = (): void => {
    measureQueued = false;
    if (closed || !observed) return;
    resize(measure(win, observed));
  };

  const queueMeasure = (): void => {
    if (measureQueued || closed) return;
    measureQueued = true;
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(measureNow);
    else win.setTimeout(measureNow, 16);
  };

  const onMessage = (event: MessageEvent): void => {
    if (closed || event.source !== parent) return;
    if (targetOrigin !== '*' && event.origin !== targetOrigin) return;
    const data: unknown = event.data;
    if (!isObject(data) || data.lf !== LF) return;
    if (data.type === 'init') {
      const init: FrameInit<TState> = {
        viewer: readViewer(data.viewer),
        players: readPlayers(data.players),
        locale: typeof data.locale === 'string' ? data.locale : '',
        theme: readTheme(data.theme),
        state: data.state as TState,
        revision: typeof data.revision === 'number' ? data.revision : 0,
      };
      connected = true;
      stopReady();
      if (applyTheme) applyThemeTo(doc, init.theme, init.locale);
      options.onInit?.(init);
      options.onState?.(init.state, init.revision);
      // A re-init may have changed what is shown: report the height again.
      lastHeight = -1;
      queueMeasure();
      return;
    }
    if (data.type === 'state') {
      if (!connected) return;
      options.onState?.(data.state as TState, typeof data.revision === 'number' ? data.revision : 0);
    }
  };

  win.addEventListener('message', onMessage);

  if (embedded) {
    post({ lf: LF, type: 'ready' });
    readyTimer = win.setInterval(() => {
      readyTries += 1;
      if (connected || readyTries >= READY_RETRY_LIMIT) {
        stopReady();
        return;
      }
      post({ lf: LF, type: 'ready' });
    }, READY_RETRY_MS);
  }

  if (options.autoResize !== false) {
    observed =
      typeof options.autoResize === 'object' && options.autoResize !== null
        ? options.autoResize
        : (doc.body ?? doc.documentElement);
    const RO = (win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (observed && typeof RO === 'function') {
      observer = new RO(queueMeasure);
      observer.observe(observed);
    }
    queueMeasure();
  }

  return {
    dispatch(action: TAction): void {
      if (!isObject(action) || typeof action.type !== 'string' || action.type.length === 0) {
        throw new TypeError('dispatch() needs an object with a non-empty string `type`.');
      }
      // Only JSON crosses to the host; this also throws on cycles and BigInt.
      const clean = JSON.parse(JSON.stringify(action)) as FrameAction;
      post({ lf: LF, type: 'action', action: clean });
    },
    resize,
    get connected() {
      return connected;
    },
    close(): void {
      if (closed) return;
      closed = true;
      stopReady();
      observer?.disconnect();
      observer = null;
      win.removeEventListener('message', onMessage);
    },
  };
}
