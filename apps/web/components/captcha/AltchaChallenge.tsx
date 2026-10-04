'use client';

import { useEffect, useRef, useState, type CSSProperties, type Ref } from 'react';
import type {} from 'altcha/types/react';
import type { AltchaWidgetElement } from 'altcha/types/generic';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import { loadAltcha, registerAltchaStrings, type AltchaStrings } from './altcha-loader';
import { ChallengeLoadError, ChallengeLoading, useLatest, withTimeout } from './ChallengeStatus';
import type { CaptchaHandle, CaptchaSurface } from './types';

/** The widget's row: 0.75rem padding twice, a 22px checkbox and the border. */
export const ALTCHA_HEIGHT = 48;

/** The widget's own timeout is 90 s; never wait past it. */
const SOLVE_TIMEOUT_MS = 95_000;
/** How long a just-mounted widget gets to start its own (`auto="onload"`) verification. */
const AUTO_START_GRACE_MS = 1_500;

/**
 * ALTCHA reads its colours from `--altcha-*` variables. Pointing them at
 * the app's `--lf-*` tokens makes it follow the dark, dim and light themes
 * (and the user's accent) with no JavaScript, like any other control.
 */
const THEME_VARIABLES = {
  '--altcha-color-base': 'var(--lf-surface)',
  '--altcha-color-base-content': 'var(--lf-text-primary)',
  '--altcha-color-neutral': 'var(--lf-border-subtle)',
  '--altcha-color-neutral-content': 'var(--lf-text-secondary)',
  '--altcha-border-color': 'var(--lf-border-subtle)',
  '--altcha-color-primary': 'var(--lf-user-accent)',
  '--altcha-color-primary-content': 'var(--lf-on-accent)',
  '--altcha-color-success': 'var(--lf-success)',
  '--altcha-color-success-content': 'var(--lf-surface)',
  '--altcha-color-error': 'var(--lf-danger)',
  '--altcha-color-error-content': 'var(--lf-surface)',
  '--altcha-checkbox-border-color': 'var(--lf-text-muted)',
  '--altcha-checkbox-outline-color': 'var(--lf-user-accent)',
  '--altcha-spinner-color': 'var(--lf-user-accent)',
  '--altcha-border-radius': '0.5rem',
  '--altcha-max-width': '100%',
} as CSSProperties;

/** Widget settings that have no attribute of their own. */
const CONFIGURATION = JSON.stringify({ hideFooter: true });

export function altchaChallengeUrl(surface: CaptchaSurface): string {
  return `/api/auth/captcha/challenge?surface=${encodeURIComponent(surface)}`;
}

function altchaStrings(t: Translator): AltchaStrings {
  return {
    ariaLinkLabel: t('captcha.altcha.ariaLinkLabel'),
    error: t('captcha.altcha.error'),
    expired: t('captcha.altcha.expired'),
    label: t('captcha.altcha.label'),
    loading: t('captcha.altcha.loading'),
    reload: t('captcha.altcha.reload'),
    verificationRequired: t('captcha.altcha.verificationRequired'),
    verified: t('captcha.altcha.verified'),
    verify: t('captcha.altcha.verify'),
    verifying: t('captcha.altcha.verifying'),
    waitAlert: t('captcha.altcha.waitAlert'),
  };
}

/** A few workers solve a SHA-256 challenge in well under a second. */
function workerCount(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(4, cores));
}

type StateDetail = { state?: string; payload?: string | null };

/**
 * The built-in provider: a checkbox row that solves a small proof of work
 * in the background as soon as it appears (`auto="onload"`), so by the
 * time someone presses the button it usually already reads "Verified".
 */
export function AltchaChallenge({
  surface,
  onToken,
  onReady,
  onLoadError,
}: {
  surface: CaptchaSurface;
  onToken?: (token: string | null) => void;
  onReady?: (handle: CaptchaHandle | null) => void;
  onLoadError?: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const elementRef = useRef<AltchaWidgetElement | null>(null);
  const onTokenRef = useLatest(onToken);
  const onReadyRef = useLatest(onReady);
  const onLoadErrorRef = useLatest(onLoadError);
  const language = t.locale.toLowerCase();
  const labelsRef = useLatest({ language, t });

  useEffect(() => {
    if (state === 'error') onLoadErrorRef.current?.();
  }, [state, onLoadErrorRef]);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    loadAltcha().then(
      () => {
        if (cancelled) return;
        // Before the widget's first paint, so it never flashes English.
        registerAltchaStrings(labelsRef.current.language, altchaStrings(labelsRef.current.t));
        setState('ready');
      },
      () => {
        if (!cancelled) setState('error');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, labelsRef]);

  // …and again when the page's language changes.
  useEffect(() => {
    if (state === 'ready') registerAltchaStrings(language, altchaStrings(t));
  }, [state, language, t]);

  useEffect(() => {
    if (state !== 'ready') return;
    const element = elementRef.current;
    if (!element) return;
    let token: string | null = null;
    // One verification at a time. A second `verify()` aborts the first, which
    // then ends in `error` — the sign-in race the e2e run caught.
    let solving = false;
    // `auto="onload"`: a freshly mounted widget starts its own verification a
    // moment later; until it has, starting another would be that second one.
    let autoPending = true;
    // Errors a waiting caller may still retry through.
    let retriesLeft = 0;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const waiters = new Set<(value: string | null) => void>();
    const settle = (value: string | null) => {
      for (const resolve of waiters) resolve(value);
      waiters.clear();
    };
    const publish = (value: string | null) => {
      if (value === token) return;
      token = value;
      onTokenRef.current?.(value);
    };
    const isSolving = () => solving || element.getState?.() === 'verifying';
    // The widget may have started (or even finished) its own run before
    // this listener was attached; its state says so even if we missed the event.
    const noteWidgetState = () => {
      const current = element.getState?.();
      if (current && current !== 'unverified') autoPending = false;
      if (current === 'verifying') solving = true;
    };
    noteWidgetState();
    const start = () => {
      solving = true;
      autoPending = false;
      void element.verify?.();
    };
    const onStateChange = (event: Event) => {
      const detail = ((event as CustomEvent<StateDetail>).detail ?? {}) as StateDetail;
      if (detail.state === 'verifying') {
        solving = true;
        autoPending = false;
      } else if (detail.state === 'verified' && detail.payload) {
        solving = false;
        publish(detail.payload);
        settle(detail.payload);
      } else if (detail.state === 'error' || detail.state === 'expired') {
        solving = false;
        publish(null);
        if (detail.state === 'error' && waiters.size > 0 && retriesLeft > 0) {
          // Someone is waiting on this one: try once more before giving up.
          retriesLeft -= 1;
          start();
          return;
        }
        settle(null);
      } else if (detail.state === 'unverified') {
        solving = false;
        publish(null);
      }
    };
    element.addEventListener('statechange', onStateChange);

    const handle: CaptchaHandle = {
      provider: 'altcha',
      surface,
      execute: async () => {
        if (token) return token;
        retriesLeft = 1;
        const solved = new Promise<string | null>((resolve) => waiters.add(resolve));
        noteWidgetState();
        if (isSolving()) {
          // Already running (the widget's own start, or ours): wait for it.
        } else if (autoPending) {
          // The widget is about to start by itself; only step in if it never does.
          clearTimeout(graceTimer);
          graceTimer = setTimeout(() => {
            if (autoPending && !isSolving() && waiters.size > 0) start();
          }, AUTO_START_GRACE_MS);
        } else {
          start();
        }
        return withTimeout(solved, SOLVE_TIMEOUT_MS, null);
      },
      reset: () => {
        publish(null);
        settle(null);
        // `reset()` aborts whatever runs; the next one starts in the
        // background, so a second attempt is instant.
        element.reset?.();
        start();
      },
    };
    onReadyRef.current?.(handle);
    return () => {
      clearTimeout(graceTimer);
      element.removeEventListener('statechange', onStateChange);
      settle(null);
      onReadyRef.current?.(null);
    };
  }, [state, surface, onReadyRef, onTokenRef]);

  if (state === 'error') return <ChallengeLoadError onRetry={() => setAttempt((n) => n + 1)} />;
  if (state === 'loading') return <ChallengeLoading minHeight={ALTCHA_HEIGHT} />;
  return (
    <altcha-widget
      ref={elementRef as Ref<HTMLElement>}
      challenge={altchaChallengeUrl(surface)}
      auto="onload"
      language={language}
      workers={workerCount()}
      configuration={CONFIGURATION}
      style={THEME_VARIABLES}
      className="block"
    />
  );
}
