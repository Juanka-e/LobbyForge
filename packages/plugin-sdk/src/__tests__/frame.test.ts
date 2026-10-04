import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRAME_MAX_HEIGHT,
  FRAME_MIN_HEIGHT,
  clampFrameHeight,
  connect,
  type FrameInit,
} from '../frame/index.js';

const ORIGIN = 'https://lobby.example';

/** A frame window with a parent, just enough for the client. */
function frameEnv(options: { embedded?: boolean; origin?: string } = {}) {
  const origin = options.origin ?? ORIGIN;
  const listeners = new Set<(event: unknown) => void>();
  const posts: Array<{ message: Record<string, unknown>; targetOrigin: string }> = [];
  const parent = {
    postMessage: (message: Record<string, unknown>, targetOrigin: string) => posts.push({ message, targetOrigin }),
  };
  const rootStyle = new Map<string, string>();
  const rootAttrs = new Map<string, string>();
  const documentElement = {
    style: { setProperty: (name: string, value: string) => rootStyle.set(name, value) },
    setAttribute: (name: string, value: string) => rootAttrs.set(name, value),
  };
  const sizes = { body: 300 };
  const body = { getBoundingClientRect: () => ({ height: sizes.body }) };
  const ro: { callback: (() => void) | null; observed: unknown[]; disconnected: boolean } = {
    callback: null,
    observed: [],
    disconnected: false,
  };
  class FakeResizeObserver {
    constructor(cb: () => void) {
      ro.callback = cb;
    }
    observe(el: unknown) {
      ro.observed.push(el);
    }
    disconnect() {
      ro.disconnected = true;
    }
  }
  const win: Record<string, unknown> = {
    document: { documentElement, body },
    location: { origin },
    addEventListener: (_type: string, fn: (event: unknown) => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: (event: unknown) => void) => listeners.delete(fn),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    requestAnimationFrame: (fn: (t: number) => void) => {
      fn(0);
      return 1;
    },
    getComputedStyle: () => ({ marginTop: '8px', marginBottom: '8.5px' }),
    ResizeObserver: FakeResizeObserver,
  };
  win.parent = options.embedded === false ? win : parent;
  const send = (data: unknown, from: { source?: unknown; origin?: string } = {}) => {
    for (const fn of [...listeners]) fn({ source: from.source ?? parent, origin: from.origin ?? origin, data });
  };
  return { win: win as unknown as Window, posts, send, rootStyle, rootAttrs, sizes, ro, listeners, body };
}

const init = (overrides: Record<string, unknown> = {}) => ({
  lf: 1,
  type: 'init',
  viewer: { userId: 'u1', isHost: true },
  players: [
    { userId: 'u1', name: 'Ayşe', isHost: true },
    { userId: 'u2', name: null, isHost: false },
  ],
  locale: 'tr',
  theme: { scheme: 'light', vars: { '--lf-surface': '#ffffff', '--lf-text-primary': '#101826' } },
  state: { phase: 'armed', round: 1 },
  revision: 1,
  ...overrides,
});

const typesPosted = (posts: Array<{ message: Record<string, unknown> }>) => posts.map((p) => p.message.type);

describe('frame client — handshake', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('says ready to its parent, on the frame URL origin, and repeats until init', () => {
    const env = frameEnv();
    const lf = connect({ window: env.win, autoResize: false });
    expect(env.posts[0]).toEqual({ message: { lf: 1, type: 'ready' }, targetOrigin: ORIGIN });
    vi.advanceTimersByTime(250 * 3);
    expect(typesPosted(env.posts)).toEqual(['ready', 'ready', 'ready', 'ready']);
    expect(lf.connected).toBe(false);

    env.send(init());
    expect(lf.connected).toBe(true);
    const count = env.posts.length;
    vi.advanceTimersByTime(5_000);
    expect(env.posts.length).toBe(count);
    lf.close();
  });

  it('gives up retrying after ten seconds without a parent answer', () => {
    const env = frameEnv();
    connect({ window: env.win, autoResize: false });
    vi.advanceTimersByTime(60_000);
    expect(env.posts.length).toBe(40);
  });

  it('falls back to "*" only when the frame URL has no http(s) origin', () => {
    const env = frameEnv({ origin: 'null' });
    connect({ window: env.win, autoResize: false });
    expect(env.posts[0]!.targetOrigin).toBe('*');
  });

  it('posts nothing when it is not inside a frame', () => {
    const env = frameEnv({ embedded: false });
    const lf = connect({ window: env.win, autoResize: false });
    lf.dispatch({ type: 'buzz' });
    lf.resize(400);
    vi.advanceTimersByTime(1_000);
    expect(env.posts).toEqual([]);
  });
});

describe('frame client — messages from the parent', () => {
  it('hands init to onInit and the state to onState, then applies theme and language', () => {
    const env = frameEnv();
    const inits: FrameInit[] = [];
    const states: Array<[unknown, number]> = [];
    connect({ window: env.win, autoResize: false, onInit: (i) => inits.push(i), onState: (s, r) => states.push([s, r]) });
    env.send(
      init({
        theme: {
          scheme: 'light',
          vars: { '--lf-surface': '#ffffff', 'color': 'red', '--evil;x': 'y', '--lf-text-primary': 42 },
        },
      })
    );
    expect(inits).toHaveLength(1);
    expect(inits[0]!.viewer).toEqual({ userId: 'u1', isHost: true });
    expect(inits[0]!.players).toEqual([
      { userId: 'u1', name: 'Ayşe', isHost: true },
      { userId: 'u2', name: null, isHost: false },
    ]);
    expect(inits[0]!.locale).toBe('tr');
    // Only well-formed --lf-* names with string values survive.
    expect(inits[0]!.theme).toEqual({ scheme: 'light', vars: { '--lf-surface': '#ffffff' } });
    expect(states).toEqual([[{ phase: 'armed', round: 1 }, 1]]);

    expect(env.rootStyle.get('--lf-surface')).toBe('#ffffff');
    expect(env.rootStyle.has('color')).toBe(false);
    expect(env.rootStyle.get('color-scheme')).toBe('light');
    expect(env.rootAttrs.get('data-lf-theme')).toBe('light');
    expect(env.rootAttrs.get('lang')).toBe('tr');
  });

  it('can leave the theme alone', () => {
    const env = frameEnv();
    connect({ window: env.win, autoResize: false, applyTheme: false });
    env.send(init());
    expect(env.rootStyle.size).toBe(0);
  });

  it('delivers state only after init, with its revision', () => {
    const env = frameEnv();
    const states: Array<[unknown, number]> = [];
    connect({ window: env.win, autoResize: false, onState: (s, r) => states.push([s, r]) });
    env.send({ lf: 1, type: 'state', state: { early: true }, revision: 0 });
    expect(states).toEqual([]);
    env.send(init());
    env.send({ lf: 1, type: 'state', state: { phase: 'open' }, revision: 2 });
    expect(states).toEqual([
      [{ phase: 'armed', round: 1 }, 1],
      [{ phase: 'open' }, 2],
    ]);
  });

  it('ignores messages from another window, another origin, or without lf: 1', () => {
    const env = frameEnv();
    const onInit = vi.fn();
    const lf = connect({ window: env.win, autoResize: false, onInit });
    env.send(init(), { source: {} });
    env.send(init(), { origin: 'https://evil.example' });
    env.send({ ...init(), lf: 2 });
    env.send('init');
    env.send(null);
    expect(onInit).not.toHaveBeenCalled();
    expect(lf.connected).toBe(false);
  });

  it('stops listening once closed', () => {
    const env = frameEnv();
    const onInit = vi.fn();
    const lf = connect({ window: env.win, onInit });
    lf.close();
    env.send(init());
    expect(onInit).not.toHaveBeenCalled();
    expect(env.listeners.size).toBe(0);
    expect(env.ro.disconnected).toBe(true);
  });
});

describe('frame client — dispatch', () => {
  it('posts the action as plain JSON', () => {
    const env = frameEnv();
    const lf = connect({ window: env.win, autoResize: false });
    lf.dispatch({ type: 'buzz', at: undefined, note: 'hi', fn: (() => 1) as unknown as string });
    expect(env.posts.at(-1)).toEqual({
      message: { lf: 1, type: 'action', action: { type: 'buzz', note: 'hi' } },
      targetOrigin: ORIGIN,
    });
  });

  it('refuses an action without a type, or one that is not JSON', () => {
    const env = frameEnv();
    const lf = connect({ window: env.win, autoResize: false });
    expect(() => lf.dispatch({} as never)).toThrow(TypeError);
    expect(() => lf.dispatch({ type: '' })).toThrow(TypeError);
    expect(() => lf.dispatch(null as never)).toThrow(TypeError);
    const cyclic: Record<string, unknown> = { type: 'loop' };
    cyclic.self = cyclic;
    expect(() => lf.dispatch(cyclic as never)).toThrow();
    expect(typesPosted(env.posts)).toEqual(['ready']);
  });
});

describe('frame client — resize', () => {
  it('reports the body height with its margins at start and on every resize', () => {
    const env = frameEnv();
    connect({ window: env.win });
    expect(env.ro.observed).toEqual([env.body]);
    expect(env.posts.at(-1)!.message).toEqual({ lf: 1, type: 'resize', height: 317 });
    env.sizes.body = 640.2;
    env.ro.callback!();
    expect(env.posts.at(-1)!.message).toEqual({ lf: 1, type: 'resize', height: 657 });
    // Same height again: nothing new is posted.
    const count = env.posts.length;
    env.ro.callback!();
    expect(env.posts.length).toBe(count);
  });

  it('measures the element it is given', () => {
    const env = frameEnv();
    const el = { getBoundingClientRect: () => ({ height: 410 }) } as unknown as Element;
    connect({ window: env.win, autoResize: el });
    expect(env.ro.observed).toEqual([el]);
    expect(env.posts.at(-1)!.message).toEqual({ lf: 1, type: 'resize', height: 427 });
  });

  it('lets the author resize by hand, ignoring nonsense', () => {
    const env = frameEnv();
    const lf = connect({ window: env.win, autoResize: false });
    expect(env.ro.observed).toEqual([]);
    lf.resize(480.1);
    lf.resize(Number.NaN);
    lf.resize(-5);
    lf.resize(Number.POSITIVE_INFINITY);
    expect(env.posts.filter((p) => p.message.type === 'resize').map((p) => p.message.height)).toEqual([481]);
  });
});

describe('clampFrameHeight', () => {
  it('keeps heights between the protocol limits', () => {
    expect(clampFrameHeight(50)).toBe(FRAME_MIN_HEIGHT);
    expect(clampFrameHeight(5000)).toBe(FRAME_MAX_HEIGHT);
    expect(clampFrameHeight(640.4)).toBe(640);
    expect(clampFrameHeight(Number.NaN)).toBe(FRAME_MIN_HEIGHT);
  });
});

describe('vendored copy', () => {
  it('examples/plugins/sandbox-buzzer/ui/lobbyforge-frame.js matches src/frame/client.ts', () => {
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/vendor-frame-client.mjs');
    // Throws (non-zero exit) when the copy is stale.
    expect(() => execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
