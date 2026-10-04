// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import {
  FRAME_READY_TIMEOUT_MS,
  PluginFrame,
  PluginFrameSurface,
  createActionLimiter,
  parseFrameMessage,
  type PluginFrameProps,
} from '../PluginFrame';

/**
 * The parent side of frame protocol v1: a marketplace plugin's UI in a
 * sandboxed iframe. It must listen to that iframe only, check every message,
 * rate-limit actions, clamp heights and post nothing but the viewer's
 * projected state.
 */

const wrap = (ui: ReactNode) => <I18nProvider {...providerPropsFor('en')}>{ui}</I18nProvider>;

const PROJECTED = { phase: 'armed', round: 2, you: { buzzed: false } };

function baseProps(overrides: Partial<PluginFrameProps> = {}): PluginFrameProps {
  return {
    pluginId: 'sandbox-buzzer',
    version: '1.0.0',
    appName: 'Buzzer',
    hasProjection: true,
    state: PROJECTED,
    viewerId: 'u1',
    hostUserId: 'u1',
    players: [
      { userId: 'u1', name: 'Ayşe' },
      { userId: 'u2', name: null },
    ],
    dispatch: vi.fn(),
    ...overrides,
  };
}

/** The iframe's window, as the component sees it. */
function fakeFrameWindow() {
  return { postMessage: vi.fn() };
}

function mount(props: PluginFrameProps) {
  const utils = render(wrap(<PluginFrame {...props} />));
  const iframe = utils.container.querySelector('iframe') as HTMLIFrameElement;
  const frameWindow = fakeFrameWindow();
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => frameWindow });
  return { ...utils, iframe, frameWindow };
}

function send(source: unknown, data: unknown, origin = 'null') {
  const event = new MessageEvent('message', { data, origin });
  Object.defineProperty(event, 'source', { value: source });
  act(() => {
    window.dispatchEvent(event);
  });
}

const posted = (w: { postMessage: ReturnType<typeof vi.fn> }) =>
  w.postMessage.mock.calls.map(([message, target]) => ({ message: message as Record<string, unknown>, target }));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  document.documentElement.className = 'lf-theme-dim';
  document.documentElement.style.setProperty('--lf-surface', '#18202b');
  document.documentElement.style.setProperty('--lf-user-accent', '#8fb8ff');
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
});

describe('PluginFrame — the iframe', () => {
  it('is sandboxed to scripts only, sends no referrer and loads the active version', () => {
    const { iframe } = mount(baseProps());
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe.getAttribute('src')).toBe('/api/plugin-ui/sandbox-buzzer/1.0.0/index.html');
    expect(iframe.getAttribute('title')).toBe('Buzzer — app screen');
    expect(iframe.hasAttribute('allow')).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent('Loading Buzzer…');
  });

  it('warns when the app does not hide information, and only then', () => {
    const { unmount } = mount(baseProps({ hasProjection: false }));
    expect(screen.getByRole('note')).toHaveTextContent("This app doesn't hide information.");
    unmount();
    mount(baseProps({ hasProjection: true }));
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('PluginFrame — handshake and state', () => {
  it('answers ready with init: viewer, players, language, theme and the projected state', () => {
    const { frameWindow } = mount(baseProps());
    send(frameWindow, { lf: 1, type: 'ready' });
    const [first] = posted(frameWindow);
    expect(first!.target).toBe('*');
    expect(first!.message).toEqual({
      lf: 1,
      type: 'init',
      viewer: { userId: 'u1', isHost: true },
      players: [
        { userId: 'u1', name: 'Ayşe', isHost: true },
        { userId: 'u2', name: null, isHost: false },
      ],
      locale: 'en',
      theme: { scheme: 'dim', vars: expect.objectContaining({ '--lf-surface': '#18202b' }) },
      state: PROJECTED,
      revision: 1,
    });
    // Loaded: the loading veil is gone.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('posts every new projected state with a rising revision, and only after ready', () => {
    const props = baseProps();
    const { frameWindow, rerender } = mount(props);
    rerender(wrap(<PluginFrame {...props} state={{ phase: 'open', round: 2 }} />));
    expect(posted(frameWindow)).toEqual([]);
    send(frameWindow, { lf: 1, type: 'ready' });
    rerender(wrap(<PluginFrame {...props} state={{ phase: 'revealed', round: 2, first: 'u2' }} />));
    const messages = posted(frameWindow).map((p) => p.message);
    expect(messages.map((m) => m.type)).toEqual(['init', 'state']);
    expect(messages[0]!.revision).toBe(2);
    expect(messages[1]).toEqual({ lf: 1, type: 'state', state: { phase: 'revealed', round: 2, first: 'u2' }, revision: 3 });
  });

  it('stops posting, and ignores a new ready, once the frame navigates to another document', () => {
    const props = baseProps();
    const { frameWindow, iframe, rerender } = mount(props);
    fireEvent.load(iframe); // the plugin's own page
    send(frameWindow, { lf: 1, type: 'ready' });
    expect(posted(frameWindow).map((p) => p.message.type)).toEqual(['init']);
    // The plugin sets location to another page frame-src allows (YouTube's
    // embed, another plugin's UI on this origin): a second load.
    fireEvent.load(iframe);
    send(frameWindow, { lf: 1, type: 'ready' });
    rerender(wrap(<PluginFrame {...props} state={{ phase: 'revealed', round: 2, secret: 'x' }} />));
    expect(posted(frameWindow).map((p) => p.message.type)).toEqual(['init']);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('sends a fresh init when the people change', () => {
    const props = baseProps();
    const { frameWindow, rerender } = mount(props);
    send(frameWindow, { lf: 1, type: 'ready' });
    rerender(wrap(<PluginFrame {...props} players={[...props.players, { userId: 'u3', name: 'Can' }]} />));
    const inits = posted(frameWindow).filter((p) => p.message.type === 'init');
    expect(inits).toHaveLength(2);
    expect((inits[1]!.message.players as unknown[]).length).toBe(3);
  });

  it('offers a retry when the frame never says ready', () => {
    vi.useFakeTimers();
    const { container } = render(wrap(<PluginFrame {...baseProps()} />));
    act(() => {
      vi.advanceTimersByTime(FRAME_READY_TIMEOUT_MS + 1);
    });
    expect(screen.getByRole('alert')).toHaveTextContent("This app didn't start");
    const before = container.querySelector('iframe');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Loading Buzzer…');
    // A new iframe, so a new document.
    expect(container.querySelector('iframe')).not.toBe(before);
  });
});

describe('PluginFrame — what it accepts', () => {
  it('ignores messages from any other window, and from a frame that is not sandboxed', () => {
    const { frameWindow } = mount(baseProps());
    send(window, { lf: 1, type: 'ready' });
    send({ postMessage: vi.fn() }, { lf: 1, type: 'ready' });
    send(null, { lf: 1, type: 'ready' });
    // Right window, but a real origin: the sandbox is not in effect.
    send(frameWindow, { lf: 1, type: 'ready' }, 'http://localhost:3000');
    expect(posted(frameWindow)).toEqual([]);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('dispatches actions through the session hook, without a frame-chosen idempotency key', () => {
    const dispatch = vi.fn();
    const { frameWindow } = mount(baseProps({ dispatch }));
    // Not before ready.
    send(frameWindow, { lf: 1, type: 'action', action: { type: 'buzz' } });
    expect(dispatch).not.toHaveBeenCalled();
    send(frameWindow, { lf: 1, type: 'ready' });
    send(frameWindow, { lf: 1, type: 'action', action: { type: 'buzz', actionId: 'replayed', note: 'x' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'buzz', note: 'x' });
  });

  it('drops malformed and oversized messages', () => {
    const dispatch = vi.fn();
    const { frameWindow, iframe } = mount(baseProps({ dispatch }));
    send(frameWindow, { lf: 1, type: 'ready' });
    const bad: unknown[] = [
      { lf: 2, type: 'action', action: { type: 'buzz' } },
      { lf: 1, type: 'eval', code: 'x' },
      { lf: 1, type: 'action', action: { kind: 'buzz' } },
      { lf: 1, type: 'action', action: { type: '' } },
      { lf: 1, type: 'action', action: { type: 'x'.repeat(101) } },
      { lf: 1, type: 'action', action: 'buzz' },
      { lf: 1, type: 'resize', height: '9999' },
      { lf: 1, type: 'action', action: { type: 'buzz', blob: 'x'.repeat(64 * 1024) } },
      'ready',
      null,
    ];
    for (const data of bad) send(frameWindow, data);
    expect(dispatch).not.toHaveBeenCalled();
    expect(iframe.style.height).toBe('360px');
    expect(warn).toHaveBeenCalled();
  });

  it('forwards at most 10 actions a second and logs the rest', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const dispatch = vi.fn();
    const { frameWindow } = mount(baseProps({ dispatch }));
    send(frameWindow, { lf: 1, type: 'ready' });
    for (let i = 0; i < 15; i += 1) send(frameWindow, { lf: 1, type: 'action', action: { type: 'buzz', i } });
    expect(dispatch).toHaveBeenCalledTimes(10);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped actions over the limit of 10 per second'));
    now.mockReturnValue(1_001_001);
    send(frameWindow, { lf: 1, type: 'action', action: { type: 'buzz', i: 99 } });
    expect(dispatch).toHaveBeenCalledTimes(11);
    now.mockRestore();
  });

  it('clamps heights between 200 and 1200 pixels', () => {
    const { frameWindow, iframe } = mount(baseProps());
    send(frameWindow, { lf: 1, type: 'resize', height: 50 });
    expect(iframe.style.height).toBe('200px');
    send(frameWindow, { lf: 1, type: 'resize', height: 99_999 });
    expect(iframe.style.height).toBe('1200px');
    send(frameWindow, { lf: 1, type: 'resize', height: 640.4 });
    expect(iframe.style.height).toBe('640px');
  });
});

describe('parseFrameMessage / createActionLimiter', () => {
  it('accepts exactly the three frame messages', () => {
    expect(parseFrameMessage({ lf: 1, type: 'ready' })).toEqual({ lf: 1, type: 'ready' });
    expect(parseFrameMessage({ lf: 1, type: 'resize', height: 300 })).toEqual({ lf: 1, type: 'resize', height: 300 });
    expect(parseFrameMessage({ lf: 1, type: 'action', action: { type: 'buzz', n: 1 } })).toEqual({
      lf: 1,
      type: 'action',
      action: { type: 'buzz', n: 1 },
    });
    expect(parseFrameMessage({ lf: 1, type: 'init', state: {} })).toBeNull();
    expect(parseFrameMessage({ lf: 1, type: 'resize', height: Number.POSITIVE_INFINITY })).toBeNull();
    const cyclic: Record<string, unknown> = { lf: 1, type: 'action' };
    cyclic.action = cyclic;
    expect(parseFrameMessage(cyclic)).toBeNull();
  });

  it('measures the size in UTF-8 bytes', () => {
    // 22k three-byte characters: under 64 Ki UTF-16 units, over 64 KiB of UTF-8.
    expect(parseFrameMessage({ lf: 1, type: 'action', action: { type: 'say', text: '€'.repeat(22_000) } })).toBeNull();
    expect(parseFrameMessage({ lf: 1, type: 'action', action: { type: 'say', text: '€'.repeat(20_000) } })).not.toBeNull();
  });

  it('limits a sliding one-second window', () => {
    let t = 0;
    const allow = createActionLimiter(3, 1000, () => t);
    expect([allow(), allow(), allow(), allow()]).toEqual([true, true, true, false]);
    t = 999;
    expect(allow()).toBe(false);
    t = 1000;
    expect(allow()).toBe(true);
  });
});

function surfaceProps() {
  const { version: _version, hasProjection: _hasProjection, ...rest } = baseProps();
  return rest;
}

describe('PluginFrameSurface', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('frames the version the server names, with its projection flag', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ frame: { pluginId: 'sandbox-buzzer', version: '1.2.3', hasProjection: false } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(
      wrap(<PluginFrameSurface {...surfaceProps()} fallback={<p>no surface</p>} />)
    );
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/plugin-ui/sandbox-buzzer', expect.objectContaining({ credentials: 'same-origin' }));
    expect(container.querySelector('iframe')!.getAttribute('src')).toBe('/api/plugin-ui/sandbox-buzzer/1.2.3/index.html');
    expect(screen.getByRole('note')).toBeInTheDocument();
  });

  it('falls back when the plugin has no UI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ frame: null }, { status: 404 })));
    render(wrap(<PluginFrameSurface {...surfaceProps()} fallback={<p>no surface</p>} />));
    expect(await screen.findByText('no surface')).toBeInTheDocument();
  });
});
