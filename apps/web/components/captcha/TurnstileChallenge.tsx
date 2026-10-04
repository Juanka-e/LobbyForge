'use client';

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { ChallengeLoadError, ChallengeLoading, reloadPage, useLatest, withTimeout } from './ChallengeStatus';
import { TURNSTILE_ORIGINS, TURNSTILE_SCRIPT, turnstileLanguage, useCspBlocked } from './external-widgets';
import { loadExternalScript } from './load-script';
import { useColorScheme } from './useColorScheme';
import type { CaptchaHandle, CaptchaSurface, TurnstileAppearance } from './types';

/** Cloudflare's widget is 65 px tall when it shows. */
const TURNSTILE_HEIGHT = 65;
/** A non-interactive run takes a second or two; past this, ask the person. */
const PENDING_TIMEOUT_MS = 15_000;

/**
 * Cloudflare Turnstile, rendered explicitly. In `interaction-only` it
 * stays invisible unless Cloudflare wants a click, so nothing is reserved
 * for it; `always` gets a placeholder of its height while loading.
 */
export function TurnstileChallenge({
  surface,
  siteKey,
  appearance,
  onToken,
  onReady,
  onReload,
  onLoadError,
}: {
  surface: CaptchaSurface;
  siteKey: string;
  appearance: TurnstileAppearance;
  onToken?: (token: string | null) => void;
  onReady?: (handle: CaptchaHandle | null) => void;
  onReload?: () => void;
  onLoadError?: () => void;
}) {
  const t = useT();
  const scheme = useColorScheme();
  const language = turnstileLanguage(t.locale);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onTokenRef = useLatest(onToken);
  const onReadyRef = useLatest(onReady);
  const onLoadErrorRef = useLatest(onLoadError);
  const cspBlocked = useCspBlocked(TURNSTILE_ORIGINS);

  useEffect(() => {
    if (state === 'error' || cspBlocked) onLoadErrorRef.current?.();
  }, [state, cspBlocked, onLoadErrorRef]);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    loadExternalScript(TURNSTILE_SCRIPT).then(
      () => {
        if (!cancelled) setState(window.turnstile ? 'ready' : 'error');
      },
      () => {
        if (!cancelled) setState('error');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    if (state !== 'ready') return;
    const api = window.turnstile;
    const container = containerRef.current;
    if (!api || !container) return;
    let token: string | null = null;
    let interactive = false;
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
    // A fresh element per render: Turnstile owns what it renders into.
    const target = document.createElement('div');
    container.appendChild(target);
    let widgetId: string | undefined;
    try {
      widgetId = api.render(target, {
        sitekey: siteKey,
        action: surface,
        theme: scheme,
        language,
        appearance,
        size: 'flexible',
        // The token goes in our JSON body, not a hidden form field.
        'response-field': false,
        callback: (value) => {
          interactive = false;
          publish(value);
          settle(value);
        },
        'expired-callback': () => publish(null),
        'timeout-callback': () => {
          publish(null);
          settle(null);
        },
        'error-callback': () => {
          publish(null);
          settle(null);
        },
        // Cloudflare wants a click: stop waiting and let the form say so.
        'before-interactive-callback': () => {
          interactive = true;
          settle(null);
        },
        'after-interactive-callback': () => {
          interactive = false;
        },
      });
    } catch {
      target.remove();
      setState('error');
      return;
    }
    const handle: CaptchaHandle = {
      provider: 'turnstile',
      surface,
      execute: async () => {
        if (token) return token;
        if (interactive) return null;
        return withTimeout(new Promise<string | null>((resolve) => waiters.add(resolve)), PENDING_TIMEOUT_MS, null);
      },
      reset: () => {
        publish(null);
        settle(null);
        if (widgetId !== undefined) api.reset(widgetId);
      },
    };
    onReadyRef.current?.(handle);
    return () => {
      settle(null);
      onReadyRef.current?.(null);
      try {
        if (widgetId !== undefined) api.remove(widgetId);
      } catch {
        // Already gone with its element.
      }
      target.remove();
    };
  }, [state, siteKey, surface, scheme, language, appearance, onReadyRef, onTokenRef]);

  if (cspBlocked) return <ChallengeLoadError blocked onRetry={reloadPage} />;
  if (state === 'error') {
    return (
      <ChallengeLoadError
        onRetry={() => {
          setAttempt((n) => n + 1);
          onReload?.();
        }}
      />
    );
  }
  return (
    <>
      {state === 'loading' && appearance === 'always' ? <ChallengeLoading minHeight={TURNSTILE_HEIGHT} /> : null}
      <div ref={containerRef} className="max-w-full empty:hidden" />
    </>
  );
}
