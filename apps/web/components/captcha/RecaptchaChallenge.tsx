'use client';

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { rich } from '@/lib/i18n/rich';
import { ChallengeLoadError, ChallengeLoading, reloadPage, useLatest, withTimeout } from './ChallengeStatus';
import { RECAPTCHA_ORIGINS, hideRecaptchaBadge, recaptchaScriptUrl, useCspBlocked } from './external-widgets';
import { loadExternalScript, readPageNonce } from './load-script';
import { useColorScheme } from './useColorScheme';
import type { CaptchaHandle, CaptchaSurface, RecaptchaVersion } from './types';

/** The v2 checkbox frame is 78 px tall (and 304 px wide). */
const CHECKBOX_HEIGHT = 78;
const EXECUTE_TIMEOUT_MS = 15_000;
/** v2 invisible may open an image challenge; give the person time to solve it. */
const INVISIBLE_TIMEOUT_MS = 60_000;

const linkClass = 'underline decoration-border-strong underline-offset-2 hover:text-text-secondary';

/**
 * Google reCAPTCHA: the v2 checkbox, v2 invisible, or v3 (a score, no
 * widget). v3 and invisible get their token when the form is sent
 * (`execute`), which is also when Google wants it — v3 tokens last two
 * minutes. Their floating badge is hidden and replaced by the attribution
 * sentence Google asks for in that case.
 */
export function RecaptchaChallenge({
  surface,
  siteKey,
  version,
  onToken,
  onReady,
  onReload,
  onLoadError,
}: {
  surface: CaptchaSurface;
  siteKey: string;
  version: RecaptchaVersion;
  onToken?: (token: string | null) => void;
  onReady?: (handle: CaptchaHandle | null) => void;
  onReload?: () => void;
  onLoadError?: () => void;
}) {
  const t = useT();
  const scheme = useColorScheme();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onTokenRef = useLatest(onToken);
  const onReadyRef = useLatest(onReady);
  const onLoadErrorRef = useLatest(onLoadError);
  const cspBlocked = useCspBlocked(RECAPTCHA_ORIGINS);

  useEffect(() => {
    if (state === 'error' || cspBlocked) onLoadErrorRef.current?.();
  }, [state, cspBlocked, onLoadErrorRef]);
  const scriptUrl = recaptchaScriptUrl(version === 'v3' ? 'v3' : 'v2', siteKey, t.locale);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    if (version !== 'v2_checkbox') hideRecaptchaBadge(readPageNonce());
    loadExternalScript(scriptUrl)
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            const api = window.grecaptcha;
            if (!api) return reject(new Error('grecaptcha missing'));
            api.ready(resolve);
          })
      )
      .then(
        () => {
          if (!cancelled) setState('ready');
        },
        () => {
          if (!cancelled) setState('error');
        }
      );
    return () => {
      cancelled = true;
    };
  }, [scriptUrl, version, attempt]);

  useEffect(() => {
    if (state !== 'ready') return;
    const api = window.grecaptcha;
    if (!api) return;

    if (version === 'v3') {
      const handle: CaptchaHandle = {
        provider: 'recaptcha',
        surface,
        execute: () =>
          withTimeout(
            Promise.resolve(api.execute(siteKey, { action: surface }) as PromiseLike<string>).then((value) => value || null),
            EXECUTE_TIMEOUT_MS,
            null
          ),
        // Every execute is a new token already.
        reset: () => {},
      };
      onReadyRef.current?.(handle);
      return () => onReadyRef.current?.(null);
    }

    const container = containerRef.current;
    if (!container) return;
    let token: string | null = null;
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
    let failed = false;
    const target = document.createElement('div');
    container.appendChild(target);
    let widgetId: number;
    try {
      widgetId = api.render(target, {
        sitekey: siteKey,
        theme: scheme,
        size: version === 'v2_invisible' ? 'invisible' : 'normal',
        // Out of the flow and hidden (see hideRecaptchaBadge) — the
        // attribution sentence below stands in for it.
        badge: 'bottomright',
        callback: (value) => {
          failed = false;
          publish(value);
          settle(value);
        },
        'expired-callback': () => publish(null),
        'error-callback': () => {
          failed = true;
          publish(null);
          settle(null);
        },
      });
    } catch {
      target.remove();
      setState('error');
      return;
    }
    const handle: CaptchaHandle = {
      provider: 'recaptcha',
      surface,
      execute: async () => {
        if (token) return token;
        // The checkbox needs the person to tick it; say so instead of waiting.
        if (version === 'v2_checkbox') return null;
        const solved = new Promise<string | null>((resolve) => waiters.add(resolve));
        api.execute(widgetId);
        return withTimeout(solved, INVISIBLE_TIMEOUT_MS, null);
      },
      reset: () => {
        failed = false;
        publish(null);
        settle(null);
        api.reset(widgetId);
      },
      failed: () => failed,
    };
    onReadyRef.current?.(handle);
    return () => {
      settle(null);
      onReadyRef.current?.(null);
      target.remove();
    };
  }, [state, version, siteKey, surface, scheme, onReadyRef, onTokenRef]);

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

  if (version === 'v2_checkbox') {
    return (
      <>
        {state === 'loading' ? <ChallengeLoading minHeight={CHECKBOX_HEIGHT} /> : null}
        {/* 304 px fixed: on the narrowest phones it is scaled to fit the card. */}
        <div ref={containerRef} className="max-w-full origin-left empty:hidden max-[399px]:scale-95" />
      </>
    );
  }

  return (
    <>
      {/* The invisible widget's badge is fixed and hidden: no layout space. */}
      <div ref={containerRef} />
      <p className="text-pretty text-xs text-text-muted">
        {rich(t('captcha.recaptcha.notice'), {
          privacy: (
            <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" className={linkClass}>
              {t('captcha.recaptcha.privacy')}
              <span className="sr-only"> {t('captcha.newTab')}</span>
            </a>
          ),
          terms: (
            <a href="https://policies.google.com/terms" target="_blank" rel="noopener noreferrer" className={linkClass}>
              {t('captcha.recaptcha.terms')}
              <span className="sr-only"> {t('captcha.newTab')}</span>
            </a>
          ),
        })}
      </p>
    </>
  );
}
