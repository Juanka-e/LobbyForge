'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { rich } from '@/lib/i18n/rich';
import {
  EXTERNAL_FRAME_SANDBOX,
  FILES_FRAME_SANDBOX,
  appOrigins,
  externalUiOrigin,
  httpOrigin,
  pluginFrameSrc,
} from '@/lib/plugin-frame-target';

export { pluginFrameSrc };

/**
 * A marketplace plugin's UI, in a sandboxed iframe (ADR-007, "Client side").
 *
 * Official plugins are trusted code and render React panels in the app
 * (PluginSurface). A marketplace plugin's author is not trusted, so its UI
 * runs in a frame, in one of two ways:
 *
 *  - Its own files (`ui: true`): `<iframe sandbox="allow-scripts">` — no
 *    `allow-same-origin`: an OPAQUE origin that cannot read the app's
 *    cookies, storage or DOM — loaded from /api/plugin-ui, whose CSP gives it
 *    no network beyond its own files and the outside origins the instance
 *    owner approved.
 *  - The author's own site (`ui: { url }`, docs/PLUGIN_UNLOCK_PLAN.md
 *    phase 2), only while the owner's approval of that URL stands (the frame
 *    info route names it only then): framed directly with
 *    `sandbox="allow-scripts allow-same-origin allow-forms
 *    allow-pointer-lock"` — never top navigation, popups or modals — and
 *    `referrerpolicy="no-referrer"`. `allow-same-origin` gives the site its
 *    own real origin and is safe only because that origin is not the app's:
 *    the URL is refused here too (render nothing, log) when it is on the
 *    page's own host (plugin-frame-target.ts). A badge above the frame names
 *    the site, so a "sign in" box inside it is visibly not this app.
 *
 * This component is the parent side of frame protocol v1
 * (@lobbyforge/plugin-sdk/frame), the same in both modes:
 *  - it only listens to messages whose `source` is THIS iframe's window AND
 *    whose origin is the expected one: "null" for its own files (the sandbox
 *    is in effect), the site's declared origin for an external UI (the
 *    iframe's window stays the same object when the frame navigates
 *    elsewhere, so the source alone proves nothing);
 *  - every message is size-checked (≤ 64 KiB) and shape-checked with zod;
 *  - actions are rate-limited (≤ 10/s, extras dropped and logged) and go
 *    through `dispatch` — the same path official panels use: the actions
 *    route, with the viewer's own session, under the plugin's action
 *    policies. The frame can do nothing the viewer could not;
 *  - heights are clamped to 200–1200 px;
 *  - what it posts is the viewer's PROJECTED state (the activity API already
 *    projected it for this viewer) plus names, language and theme. To an
 *    external site it posts with `targetOrigin` = that site's origin, so a
 *    frame that navigated elsewhere receives nothing; to its own files the
 *    target has to be '*' — an opaque origin cannot be named — which is why
 *    nothing else is ever posted.
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

/** Where the iframe points, how far it is trusted, and who may talk to it. */
export interface FrameTarget {
  src: string;
  sandbox: string;
  /** The `event.origin` of every message accepted from the frame. */
  origin: string;
  /** The `targetOrigin` of everything posted to it. */
  targetOrigin: string;
  /** An external site's host (with a non-default port), shown above the frame; null for the plugin's own files. */
  host: string | null;
}

/**
 * The frame for a plugin's own files, or — given `externalUrl` — for the
 * author's site; null when that site must not be framed: not an http(s) URL,
 * or on the host of `pageOrigin` / the configured public origin (or a
 * subdomain either way), where `allow-same-origin` would let it lift its own
 * sandbox.
 */
export function resolveFrameTarget(
  pluginId: string,
  version: string,
  externalUrl: string | null | undefined,
  pageOrigin: string | null
): FrameTarget | null {
  if (!externalUrl) {
    return { src: pluginFrameSrc(pluginId, version), sandbox: FILES_FRAME_SANDBOX, origin: 'null', targetOrigin: '*', host: null };
  }
  const origin = externalUiOrigin(externalUrl, appOrigins([pageOrigin, process.env.NEXT_PUBLIC_BASE_URL]));
  if (!origin) return null;
  return {
    src: externalUrl,
    sandbox: EXTERNAL_FRAME_SANDBOX,
    origin,
    targetOrigin: origin,
    host: new URL(externalUrl).host,
  };
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
  /**
   * The author's own page (`ui: { url }`), when the instance owner approved
   * it: framed instead of the plugin's files on this instance.
   */
  externalUrl?: string | null;
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
  externalUrl = null,
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
  const target = useMemo(
    () => resolveFrameTarget(pluginId, version, externalUrl, typeof window === 'undefined' ? null : window.location.origin),
    [pluginId, version, externalUrl]
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [attempt, setAttempt] = useState(0);
  // Bumped when an external site loads another of its own pages: that
  // document has to say `ready` again before it is told anything.
  const [handshake, setHandshake] = useState(0);
  const readyRef = useRef(false);
  // Loads of the CURRENT iframe element (reset per attempt/source). For a
  // plugin's own files a second load means the frame navigated itself — to
  // a page allowed by the app's frame-src (YouTube's embed, another
  // plugin's UI on this origin). From then on nothing is posted to it and
  // nothing it sends is honoured, or that page would receive this viewer's
  // state. An external site may move between its own pages (the origin
  // checks keep any other site out), so there a load restarts the handshake.
  const loadsRef = useRef(0);
  const navigatedRef = useRef(false);
  const revisionRef = useRef(0);
  const limiterRef = useRef(createActionLimiter());
  const lastDropWarningRef = useRef(0);
  const themeRef = useRef<string>('');
  const src = target?.src ?? null;
  const expectedOrigin = target?.origin ?? null;
  const targetOrigin = target?.targetOrigin ?? null;

  // The latest props, for the message handler (subscribed once per frame).
  const latest = useRef({ state, viewerId, hostUserId, players, locale, dispatch });
  latest.current = { state, viewerId, hostUserId, players, locale, dispatch };

  // Refused: nothing is framed (see resolveFrameTarget). Said once per URL.
  useEffect(() => {
    if (!target) {
      console.error(`[plugin-frame] ${pluginId}: not framing its UI, which is on this app's own address or not a web URL`);
    }
  }, [target, pluginId]);

  const post = useCallback(
    (message: HostToFrameMessage) => {
      if (!targetOrigin) return;
      // External site: only to its declared origin. Own files: an opaque
      // origin cannot be named, so '*' — only the viewer's projected state
      // is ever sent.
      iframeRef.current?.contentWindow?.postMessage(message, targetOrigin);
    },
    [targetOrigin]
  );

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
    if (!expectedOrigin) return;
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (navigatedRef.current) return;
      // Own files: an opaque origin serialises as "null"; anything else means
      // the sandbox is not in effect. External site: its declared origin
      // only — the same window may have navigated to another site.
      if (event.origin !== expectedOrigin) return;
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
  }, [pluginId, expectedOrigin, post, buildInit]);

  // A new iframe element or source: count its loads from zero.
  useEffect(() => {
    loadsRef.current = 0;
    navigatedRef.current = false;
  }, [pluginId, src, attempt]);

  // Each (re)load of the frame: wait for `ready`, give up after a while.
  useEffect(() => {
    readyRef.current = false;
    setStatus('loading');
    const timer = setTimeout(() => {
      if (!readyRef.current) setStatus('error');
    }, FRAME_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pluginId, src, attempt, handshake]);

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

  if (!target) return null;

  const title = target.host
    ? t('lobbyMain.activities.frameTitleExternal', { name: appName, host: target.host })
    : t('lobbyMain.activities.frameTitle', { name: appName });

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

      <div className={status === 'error' ? 'hidden' : 'flex flex-col'}>
        {target.host ? <ExternalSiteBadge host={target.host} /> : null}
        <div className="relative">
          {status === 'loading' ? (
            <div
              role="status"
              className={`absolute inset-0 z-[1] flex items-center justify-center gap-2 border border-border-subtle bg-surface text-sm text-text-secondary ${
                target.host ? 'rounded-b-xl' : 'rounded-xl'
              }`}
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
            src={target.src}
            title={title}
            // Own files: allow-scripts ONLY — no allow-same-origin (opaque
            // origin), forms, popups, modals, top navigation or downloads.
            // External site: its own origin plus forms and pointer lock;
            // still no popups, modals, top navigation or downloads.
            sandbox={target.sandbox}
            onLoad={() => {
              loadsRef.current += 1;
              if (loadsRef.current <= 1) return;
              readyRef.current = false;
              if (target.host) {
                // Another page of the external site: it says `ready` again.
                setHandshake((n) => n + 1);
                return;
              }
              navigatedRef.current = true;
              setStatus('error');
            }}
            referrerPolicy="no-referrer"
            style={{ height }}
            className={`block w-full border border-border-subtle bg-surface ${target.host ? 'rounded-b-xl' : 'rounded-xl'}`}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The external site's address, on the frame's top edge like an address bar:
 * whatever the page inside shows — a "sign in" box included — is that site,
 * not this app. The host comes from the approved URL, never from the page.
 */
function ExternalSiteBadge({ host }: { host: string }) {
  const t = useT();
  return (
    <div
      data-testid="plugin-frame-site"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-t-xl border border-b-0 border-border-subtle bg-surface-container px-3 py-2 text-xs"
    >
      <p className="flex min-w-0 items-center gap-1.5 text-text-secondary">
        <span className="material-symbols-outlined text-[16px] text-text-muted" aria-hidden>
          public
        </span>
        <span className="min-w-0 truncate">
          {rich(t('lobbyMain.activities.frameSite'), {
            host: (
              <span className="rounded border border-border-subtle bg-surface px-1.5 py-0.5 font-mono text-[12px] font-semibold text-text-primary">
                {host}
              </span>
            ),
          })}
        </span>
      </p>
      <p className="text-text-secondary">{t('lobbyMain.activities.frameSiteHint')}</p>
    </div>
  );
}

interface FrameInfo {
  version: string;
  hasProjection: boolean;
  externalUrl: string | null;
}

/**
 * The frame info route's answer as the lobby uses it, or null. An external
 * UI must name its URL and that URL's origin, and the two must agree.
 */
export function readFrameInfo(ok: boolean, body: unknown): FrameInfo | null {
  const frame = (body as { frame?: Record<string, unknown> | null } | null)?.frame;
  if (!ok || !frame || typeof frame.version !== 'string') return null;
  const base = { version: frame.version, hasProjection: frame.hasProjection === true };
  if (frame.mode !== 'external') return { ...base, externalUrl: null };
  if (typeof frame.src !== 'string' || typeof frame.origin !== 'string' || httpOrigin(frame.src) !== frame.origin) {
    console.error('[plugin-frame] ignored an external UI whose URL and origin disagree');
    return null;
  }
  return { ...base, externalUrl: frame.src };
}

/**
 * The lobby's surface for a plugin that is not compiled in: asks whether it
 * has a UI and frames it, or shows `fallback`.
 */
export function PluginFrameSurface({
  pluginId,
  fallback,
  ...frame
}: Omit<PluginFrameProps, 'version' | 'hasProjection' | 'externalUrl'> & { fallback: ReactNode }) {
  const t = useT();
  const [info, setInfo] = useState<FrameInfo | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setInfo(undefined);
    void (async () => {
      try {
        const res = await fetch(`/api/plugin-ui/${encodeURIComponent(pluginId)}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        const body = (await res.json().catch(() => ({}))) as unknown;
        if (!cancelled) setInfo(readFrameInfo(res.ok, body));
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
  return (
    <PluginFrame
      {...frame}
      pluginId={pluginId}
      version={info.version}
      hasProjection={info.hasProjection}
      externalUrl={info.externalUrl}
    />
  );
}
