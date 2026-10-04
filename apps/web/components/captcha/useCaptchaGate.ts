'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { withTimeout } from './ChallengeStatus';
import type { CaptchaChallengeProps } from './CaptchaChallenge';
import { useCaptchaConfig, type CaptchaConfigStatus } from './useCaptchaConfig';
import {
  captchaRefusalOf,
  needsWidget,
  type CaptchaConfig,
  type CaptchaFields,
  type CaptchaHandle,
  type CaptchaSurface,
} from './types';

/** The server refuses a form sent < 2 s after its formToken (§7); keep a margin. */
export const MIN_FILL_MS = 2_500;
/** …or > 2 h after: past this age, fetch a fresh one before sending. */
export const MAX_FORM_TOKEN_AGE_MS = 100 * 60_000;
/** How long a send waits for a widget to mount and load. */
const WIDGET_READY_TIMEOUT_MS = 20_000;
/** How long a send waits for a config fetch already in flight. */
const CONFIG_WAIT_MS = 5_000;

export type CaptchaSubmitResult =
  /** Anything that is not a captcha refusal — success, or the route's own error. */
  | { kind: 'response'; response: Response; body: Record<string, unknown> }
  /** The person has to act (finish the check, try again); `messageKey` says what. */
  | { kind: 'blocked'; messageKey: string }
  | { kind: 'network' };

export interface CaptchaGateOptions {
  surface: CaptchaSurface;
  /**
   * Fetch the config when the form appears — every form that sends a
   * formToken. Sign-in leaves it off: adaptive sign-in only asks after a
   * `captcha_required` answer, so it costs nothing until then.
   */
  prefetch?: boolean;
  /**
   * Keep the widget off screen until `engage()` — a second form on the
   * page (the guest form under sign-in) shows its widget only once used.
   */
  deferred?: boolean;
  /** The server already asked (a dialog opened because of `captcha_required`). */
  required?: boolean;
  /**
   * Whether this request is one the config's `required` applies to.
   * False when the server is not expected to ask — refreshing a guest who
   * already has a session — so nothing is shown or awaited unless the
   * server answers `captcha_required` after all. Default true.
   */
  expectChallenge?: boolean;
}

export interface CaptchaGate {
  surface: CaptchaSurface;
  config: CaptchaConfig | null;
  configStatus: CaptchaConfigStatus;
  /** A challenge belongs on screen now. */
  showChallenge: boolean;
  /** A challenge is expected but its config is still loading or failed. */
  expectingChallenge: boolean;
  /** A token is ready (ALTCHA solved, Turnstile passed, a box ticked). */
  hasToken: boolean;
  engage: () => void;
  refreshConfig: () => Promise<CaptchaConfig | null>;
  challengeProps: CaptchaChallengeProps;
  honeypot: { value: string; onChange: (value: string) => void };
  /**
   * Send a protected request: collect the token, formToken and honeypot,
   * call `send` with them, and handle the §4.4 refusals — one automatic
   * retry after `captcha_required` (the widget appears and solves) and
   * after `captcha_unavailable` (the server switched to ALTCHA).
   */
  submit: (send: (fields: CaptchaFields) => Promise<Response>) => Promise<CaptchaSubmitResult>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Collected = { kind: 'ok'; fields: CaptchaFields } | { kind: 'blocked'; messageKey: string };

/**
 * Everything a protected form needs from bot protection, in one hook. The
 * form renders `<CaptchaField gate={gate} />` inside itself and sends
 * through `gate.submit`.
 */
export function useCaptchaGate({
  surface,
  prefetch = true,
  deferred = false,
  required = false,
  expectChallenge = true,
}: CaptchaGateOptions): CaptchaGate {
  const [activated, setActivated] = useState(required);
  const [forced, setForced] = useState(required);
  const [engaged, setEngaged] = useState(!deferred);
  const [honeypot, setHoneypot] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const state = useCaptchaConfig(surface, { enabled: prefetch || activated });
  const config = state.config?.surface === surface ? state.config : null;

  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  const forcedRef = useRef(required);
  const expectRef = useRef(expectChallenge);
  expectRef.current = expectChallenge;
  const honeypotRef = useRef('');
  honeypotRef.current = honeypot;
  const latestRef = useRef<{ config: CaptchaConfig | null; receivedAt: number | null }>({ config: null, receivedAt: null });
  useEffect(() => {
    latestRef.current = { config: state.config, receivedAt: state.receivedAt };
  }, [state.config, state.receivedAt]);

  const handleRef = useRef<CaptchaHandle | null>(null);
  const waitersRef = useRef(new Set<(handle: CaptchaHandle | null) => void>());
  const loadFailedRef = useRef(false);
  const { refetch, pending: pendingConfig } = state;

  const refreshConfig = useCallback(async () => {
    setActivated(true);
    // A new config may name another provider; its widget gets a fresh chance.
    loadFailedRef.current = false;
    const fresh = await refetch();
    latestRef.current = { config: fresh, receivedAt: fresh ? Date.now() : null };
    return fresh;
  }, [refetch]);

  const engage = useCallback(() => setEngaged(true), []);

  const onReady = useCallback((handle: CaptchaHandle | null) => {
    handleRef.current = handle;
    if (!handle) return;
    loadFailedRef.current = false;
    for (const resolve of waitersRef.current) resolve(handle);
    waitersRef.current.clear();
  }, []);

  const onLoadError = useCallback(() => {
    loadFailedRef.current = true;
    for (const resolve of waitersRef.current) resolve(null);
    waitersRef.current.clear();
  }, []);

  const onToken = useCallback((token: string | null) => setHasToken(Boolean(token)), []);

  /** The handle of the widget for this provider and surface, once it is up. */
  const waitForHandle = useCallback(async (provider: CaptchaConfig['provider'], target: CaptchaSurface) => {
    const matches = (handle: CaptchaHandle | null) => handle && handle.provider === provider && handle.surface === target;
    const deadline = Date.now() + WIDGET_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (matches(handleRef.current)) return handleRef.current;
      // The widget is showing its load error (and a retry): do not hang.
      if (loadFailedRef.current) return null;
      const next = await withTimeout(
        new Promise<CaptchaHandle | null>((resolve) => waitersRef.current.add(resolve)),
        Math.max(0, deadline - Date.now()),
        null
      );
      if (matches(next)) return next;
    }
    return null;
  }, []);

  const collect = useCallback(async (): Promise<Collected> => {
    const fields: CaptchaFields = {};
    if (honeypotRef.current) fields.website = honeypotRef.current;
    // Sent while the config is still on its way: wait for it (briefly)
    // rather than go without the formToken and earn a refusal.
    const inflight = pendingConfig();
    if (inflight) {
      const settled = await withTimeout(inflight, CONFIG_WAIT_MS, null);
      if (settled) latestRef.current = { config: settled, receivedAt: Date.now() };
    }
    let { config: current, receivedAt } = latestRef.current;
    const stale =
      (current && current.surface !== surfaceRef.current) ||
      (receivedAt !== null && Date.now() - receivedAt > MAX_FORM_TOKEN_AGE_MS) ||
      (!current && forcedRef.current);
    if (stale) {
      current = await refreshConfig();
      receivedAt = latestRef.current.receivedAt;
    }
    if (!current) {
      // Unknown protection: send without, unless the server already asked.
      return forcedRef.current ? { kind: 'blocked', messageKey: 'captcha.challenge.loadFailed' } : { kind: 'ok', fields };
    }
    if (current.formToken && receivedAt !== null) {
      const wait = MIN_FILL_MS - (Date.now() - receivedAt);
      if (wait > 0) await sleep(wait);
      fields.formToken = current.formToken;
    }
    if (needsWidget(current) && ((expectRef.current && current.required) || forcedRef.current)) {
      setEngaged(true);
      const handle = await waitForHandle(current.provider, current.surface);
      if (!handle) return { kind: 'blocked', messageKey: 'captcha.challenge.loadFailed' };
      const token = await handle.execute();
      if (!token) return { kind: 'blocked', messageKey: 'captcha.error.incomplete' };
      fields.captchaToken = token;
      fields.captchaProvider = handle.provider;
    }
    return { kind: 'ok', fields };
  }, [pendingConfig, refreshConfig, waitForHandle]);

  const submit = useCallback(
    async (send: (fields: CaptchaFields) => Promise<Response>): Promise<CaptchaSubmitResult> => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const collected = await collect();
        if (collected.kind === 'blocked') return collected;
        let response: Response;
        try {
          response = await send(collected.fields);
        } catch {
          return { kind: 'network' };
        }
        // Tokens are single use, whatever the answer: start the next one now.
        if (collected.fields.captchaToken) handleRef.current?.reset();
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const refusal = response.status === 400 ? captchaRefusalOf(body) : null;
        if (!refusal) return { kind: 'response', response, body };

        if (refusal === 'captcha_required') {
          forcedRef.current = true;
          setForced(true);
          setEngaged(true);
          if (!latestRef.current.config) await refreshConfig();
          if (attempt === 0) continue;
          return { kind: 'blocked', messageKey: 'captcha.error.required' };
        }
        if (refusal === 'captcha_unavailable') {
          // The provider the widget used is out; the config now names ALTCHA.
          handleRef.current = null;
          await refreshConfig();
          if (attempt === 0) continue;
          return { kind: 'blocked', messageKey: 'captcha.error.unavailable' };
        }
        if (refusal === 'captcha_invalid') return { kind: 'blocked', messageKey: 'captcha.error.invalid' };
        // form_rejected: the next try needs a fresh formToken.
        await refreshConfig();
        return { kind: 'blocked', messageKey: 'captcha.error.formRejected' };
      }
      return { kind: 'blocked', messageKey: 'captcha.error.required' };
    },
    [collect, refreshConfig]
  );

  const showChallenge = engaged && needsWidget(config) && Boolean((expectChallenge && config?.required) || forced);
  const expectingChallenge = engaged && forced && !config && (state.status === 'loading' || state.status === 'error');

  const challengeProps = useMemo<CaptchaChallengeProps>(
    () => ({
      surface,
      config,
      onReady,
      onToken,
      onLoadError,
      // "Try again" on a widget that failed: the server may have switched to ALTCHA meanwhile.
      onReload: () => void refreshConfig(),
    }),
    [surface, config, onReady, onToken, onLoadError, refreshConfig]
  );

  return {
    surface,
    config,
    configStatus: state.status,
    showChallenge,
    expectingChallenge,
    hasToken,
    engage,
    refreshConfig,
    challengeProps,
    honeypot: { value: honeypot, onChange: setHoneypot },
    submit,
  };
}
