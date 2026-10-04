'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import {
  FRAME_MAX_ACTIONS_PER_SECOND,
  FRAME_MAX_ACTION_TYPE_LENGTH,
  FRAME_MAX_MESSAGE_BYTES,
  FRAME_PROTOCOL_VERSION,
  FRAME_THEME_VARIABLES,
  clampFrameHeight,
  type FrameColorScheme,
  type FrameInitMessage,
  type FrameTheme,
  type FrameToHostMessage,
  type HostToFrameMessage,
} from '@lobbyforge/plugin-sdk/frame';
import { useLocale, useT } from '@/lib/i18n/client';

/**
 * A marketplace plugin's UI, in a sandboxed iframe (ADR-007, "Client side").
 *
 * Official plugins are trusted code and render React panels in the app
 * (PluginSurface). A marketplace plugin's author is not trusted, so its UI
 * runs in `<iframe sandbox="allow-scripts">` — no `allow-same-origin`: an
 * OPAQUE origin that cannot read the app's cookies, storage or DOM — loaded
 * from /api/plugin-ui, whose CSP gives it no network at all.
 *
 * This component is the parent side of frame protocol v1
 * (@lobbyforge/plugin-sdk/frame):
 *  - it only listens to messages whose `source` is THIS iframe's window and
 *    whose origin is "null" (the sandbox is in effect);
 *  - every message is size-checked (≤ 64 KiB) and shape-checked with zod;
 *  - actions are rate-limited (≤ 10/s, extras dropped and logged) and go
 *    through `dispatch` — the same path official panels use: the actions
 *    route, with the viewer's own session, under the plugin's action
 *    policies. The frame can do nothing the viewer could not;
 *  - heights are clamped to 200–1200 px;
 *  - what it posts is the viewer's PROJECTED state (the activity API already
 *    projected it for this viewer) plus names, language and theme. The
 *    target origin has to be '*' — an opaque origin cannot be named — which
 *    is why nothing else is ever posted.
 */

/** zod for what a frame may send; typed against the SDK so both sides share one definition. */
const FrameToHostSchema: z.ZodType<FrameToHostMessage> = z.discriminatedUnion('type', [
  z.object({ lf: z.literal(FRAME_PROTOCOL_VERSION), type: z.literal('ready') }),
  z.object({
    lf: z.literal(FRAME_PROTOCOL_VERSION),
    type: z.literal('action'),
    action: z.object({ type: z.string().min(1).max(FRAME_MAX_ACTION_TYPE_LENGTH) }).passthrough(),
  }),
  z.object({
    lf: z.literal(FRAME_PROTOCOL_VERSION),
    type: z.literal('resize'),
    height: z.number().finite(),
  }),
]);

const FRAME_MESSAGE_TYPES = new Set(['ready', 'action', 'resize']);

/**
 * A frame's message, or null when it is not protocol v1, too big (UTF-8
 * bytes of its JSON over FRAME_MAX_MESSAGE_BYTES) or the wrong shape.
 */
export function parseFrameMessage(data: unknown): FrameToHostMessage | null {
  // Cheap rejections first, before serialising anything.
  if (typeof data !== 'object' || data === null) return null;
  const head = data as { lf?: unknown; type?: unknown };
  if (head.lf !== FRAME_PROTOCOL_VERSION || typeof head.type !== 'string' || !FRAME_MESSAGE_TYPES.has(head.type)) {
    return null;
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch {
    return null;
  }
  if (json === undefined) return null;
  // A UTF-8 encoding is never shorter than the UTF-16 length.
  if (json.length > FRAME_MAX_MESSAGE_BYTES) return null;
  if (new TextEncoder().encode(json).byteLength > FRAME_MAX_MESSAGE_BYTES) return null;
  const parsed = FrameToHostSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : null;
}

/** A sliding one-second window: true while fewer than `limit` actions passed in it. */
export function createActionLimiter(
  limit: number = FRAME_MAX_ACTIONS_PER_SECOND,
  windowMs = 1000,
  now: () => number = () => Date.now()
): () => boolean {
  const stamps: number[] = [];
  return () => {
    const t = now();
    while (stamps.length > 0 && t - (stamps[0] as number) >= windowMs) stamps.shift();
    if (stamps.length >= limit) return false;
    stamps.push(t);
    return true;
  };
}

/** The viewer's current theme: which one, and the values of the `--lf-*` variables. */
export function readHostTheme(root: HTMLElement = document.documentElement): FrameTheme {
  const style = getComputedStyle(root);
  const vars: Record<string, string> = {};
  for (const name of FRAME_THEME_VARIABLES) {
    const value = style.getPropertyValue(name).trim();
    if (value) vars[name] = value;
  }
  const scheme: FrameColorScheme = root.classList.contains('lf-theme-light')
    ? 'light'
    : root.classList.contains('lf-theme-dim')
      ? 'dim'
      : 'dark';
  return { scheme, vars };
}

export function pluginFrameSrc(pluginId: string, version: string): string {
  return `/api/plugin-ui/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/index.html`;
}

const DEFAULT_HEIGHT = 360;
/** How long a frame has to say `ready` before the lobby offers a retry. */
export const FRAME_READY_TIMEOUT_MS = 10_000;

export interface PluginFramePlayer {
  userId: string;
  name: string | null;
}

export interface PluginFrameProps {
  pluginId: string;
  version: string;
  /** The app's display name, for the frame's accessible title. */
  appName: string;
  hasProjection: boolean;
  /** The state the activity API projected for THIS viewer. Never the raw state. */
  state: unknown;
  viewerId: string;
  hostUserId: string | null;
  players: PluginFramePlayer[];
  dispatch: (action: Record<string, unknown>) => unknown;
}

type Status = 'loading' | 'ready' | 'error';

export function PluginFrame({
  pluginId,
  version,
  appName,
  hasProjection,
  state,
  viewerId,
  hostUserId,
  players,
  dispatch,
}: PluginFrameProps) {
  const t = useT();
  const locale = useLocale();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [attempt, setAttempt] = useState(0);
  const readyRef = useRef(false);
  // Loads of the CURRENT iframe element (reset per attempt/version). A
  // second load means the frame navigated itself — to a page allowed by
  // the app's frame-src (YouTube's embed, or another plugin's UI on this
  // origin). From then on nothing is posted to it and nothing it sends is
  // honoured, or that page would receive this viewer's state.
  const loadsRef = useRef(0);
  const navigatedRef = useRef(false);
  const revisionRef = useRef(0);
  const limiterRef = useRef(createActionLimiter());
  const lastDropWarningRef = useRef(0);
  const themeRef = useRef<string>('');

  // The latest props, for the message handler (subscribed once per frame).
  const latest = useRef({ state, viewerId, hostUserId, players, locale, dispatch });
  latest.current = { state, viewerId, hostUserId, players, locale, dispatch };

  const post = useCallback((message: HostToFrameMessage) => {
    // An opaque origin cannot be named, so '*' is the only target origin
    // that reaches the frame; only the viewer's projected state is sent.
    iframeRef.current?.contentWindow?.postMessage(message, '*');
  }, []);

  const buildInit = useCallback((): FrameInitMessage => {
    const { state: current, viewerId: me, hostUserId: host, players: people, locale: lang } = latest.current;
    const theme = readHostTheme();
    themeRef.current = JSON.stringify(theme);
    return {
      lf: FRAME_PROTOCOL_VERSION,
      type: 'init',
      viewer: { userId: me, isHost: Boolean(host) && me === host },
      players: people.map((p) => ({ userId: p.userId, name: p.name ?? null, isHost: p.userId === host })),
      locale: lang,
      theme,
      state: current,
      revision: revisionRef.current,
    };
  }, []);

  // Messages from the frame.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (navigatedRef.current) return;
      // An opaque origin serialises as "null". Anything else means the
      // sandbox is not in effect, and the frame is not to be trusted with more.
      if (event.origin !== 'null') return;
      const message = parseFrameMessage(event.data);
      if (!message) {
        console.warn(`[plugin-frame] ${pluginId}: dropped a malformed or oversized message`);
        return;
      }
      if (message.type === 'ready') {
        readyRef.current = true;
        setStatus('ready');
        post(buildInit());
        return;
      }
      if (message.type === 'resize') {
        setHeight(clampFrameHeight(message.height));
        return;
      }
      if (!readyRef.current) return;
      if (!limiterRef.current()) {
        const now = Date.now();
        if (now - lastDropWarningRef.current > 1000) {
          lastDropWarningRef.current = now;
          console.warn(
            `[plugin-frame] ${pluginId}: dropped actions over the limit of ${FRAME_MAX_ACTIONS_PER_SECOND} per second`
          );
        }
        return;
      }
      // The idempotency key is the host's to choose, never the frame's.
      const { actionId: _ignored, ...action } = message.action;
      void latest.current.dispatch(action);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pluginId, post, buildInit]);

  // Each (re)load of the frame: wait for `ready`, give up after a while.
  useEffect(() => {
    readyRef.current = false;
    loadsRef.current = 0;
    navigatedRef.current = false;
    setStatus('loading');
    const timer = setTimeout(() => {
      if (!readyRef.current) setStatus('error');
    }, FRAME_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pluginId, version, attempt]);

  // Every new projected state.
  useEffect(() => {
    revisionRef.current += 1;
    if (!readyRef.current) return;
    post({ lf: FRAME_PROTOCOL_VERSION, type: 'state', state, revision: revisionRef.current });
  }, [state, post]);

  // The viewer's context changed (people, language, host): a fresh init.
  const playersKey = JSON.stringify(players.map((p) => [p.userId, p.name ?? null]));
  useEffect(() => {
    if (readyRef.current) post(buildInit());
  }, [playersKey, locale, viewerId, hostUserId, post, buildInit]);

  // The theme or accent changed (a class or inline variable on <html>).
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      if (!readyRef.current) return;
      if (JSON.stringify(readHostTheme()) !== themeRef.current) post(buildInit());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => observer.disconnect();
  }, [post, buildInit]);

  const title = t('lobbyMain.activities.frameTitle', { name: appName });

  return (
    <div className="flex flex-col gap-3">
      {hasProjection ? null : (
        <p
          role="note"
          className="inline-flex max-w-full items-start gap-2 self-start rounded-lg border border-ember/40 bg-ember/10 px-3 py-2 text-xs text-text-primary"
        >
          <span className="material-symbols-outlined text-[16px] text-ember" aria-hidden>
            visibility
          </span>
          <span>
            <span className="font-semibold">{t('lobbyMain.activities.frameNoProjection')}</span>{' '}
            <span className="text-text-secondary">{t('lobbyMain.activities.frameNoProjectionHint')}</span>
          </span>
        </p>
      )}

      {status === 'error' ? (
        <div
          role="alert"
          className="rounded-xl border border-dashed border-border-subtle bg-surface/40 px-6 py-10 text-center"
        >
          <span className="material-symbols-outlined text-[32px] text-text-muted" aria-hidden>
            error
          </span>
          <h2 className="mt-3 font-body-lg font-semibold text-text-primary">
            {t('lobbyMain.activities.frameErrorTitle')}
          </h2>
          <p className="mx-auto mt-1 max-w-sm font-body-md text-text-secondary">
            {t('lobbyMain.activities.frameErrorBody', { name: appName })}
          </p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden>
              refresh
            </span>
            {t('lobbyMain.activities.frameRetry')}
          </button>
        </div>
      ) : null}

      <div className={status === 'error' ? 'hidden' : 'relative'}>
        {status === 'loading' ? (
          <div
            role="status"
            className="absolute inset-0 z-[1] flex items-center justify-center gap-2 rounded-xl border border-border-subtle bg-surface text-sm text-text-secondary"
          >
            <span className="material-symbols-outlined animate-spin text-[18px]" aria-hidden>
              progress_activity
            </span>
            {t('lobbyMain.activities.frameLoading', { name: appName })}
          </div>
        ) : null}
        <iframe
          key={attempt}
          ref={iframeRef}
          src={pluginFrameSrc(pluginId, version)}
          title={title}
          // allow-scripts ONLY: no allow-same-origin (opaque origin), no
          // forms, popups, modals, top navigation or downloads.
          sandbox="allow-scripts"
          onLoad={() => {
            loadsRef.current += 1;
            if (loadsRef.current > 1) {
              navigatedRef.current = true;
              readyRef.current = false;
              setStatus('error');
            }
          }}
          referrerPolicy="no-referrer"
          style={{ height }}
          className="block w-full rounded-xl border border-border-subtle bg-surface"
        />
      </div>
    </div>
  );
}

/**
 * The lobby's surface for a plugin that is not compiled in: asks whether it
 * has a sandboxed UI and frames it, or shows `fallback`.
 */
export function PluginFrameSurface({
  pluginId,
  fallback,
  ...frame
}: Omit<PluginFrameProps, 'version' | 'hasProjection'> & { fallback: ReactNode }) {
  const t = useT();
  const [info, setInfo] = useState<{ version: string; hasProjection: boolean } | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setInfo(undefined);
    void (async () => {
      try {
        const res = await fetch(`/api/plugin-ui/${encodeURIComponent(pluginId)}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        const body = (await res.json().catch(() => ({}))) as {
          frame?: { version?: unknown; hasProjection?: unknown } | null;
        };
        const version = res.ok && typeof body.frame?.version === 'string' ? body.frame.version : null;
        if (!cancelled) {
          setInfo(version ? { version, hasProjection: body.frame?.hasProjection === true } : null);
        }
      } catch {
        if (!cancelled) setInfo(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginId]);

  if (info === undefined) {
    return (
      <p role="status" className="py-8 text-sm text-text-muted">
        {t('lobbyMain.activities.frameLoading', { name: frame.appName })}
      </p>
    );
  }
  if (info === null) return <>{fallback}</>;
  return <PluginFrame {...frame} pluginId={pluginId} version={info.version} hasProjection={info.hasProjection} />;
}
