'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { ALTCHA_HEIGHT, altchaChallengeUrl } from './AltchaChallenge';
import { altchaPayload, isSolvableChallenge } from './altcha-fallback-solver';
import { solveInBackground } from './altcha-fallback-runner';
import { useLatest } from './ChallengeStatus';
import type { CaptchaHandle, CaptchaSurface } from './types';

type Phase = 'verifying' | 'verified' | 'expired' | 'failed';

/**
 * ALTCHA for pages without Web Crypto — a self-hosted instance reached over
 * plain HTTP on a LAN, where the browser hides `crypto.subtle` and ALTCHA's
 * widget refuses to run (with an untranslated "Secure context (HTTPS)
 * required."). The same challenge is fetched, solved by our pure-JS solver
 * in workers, and sent as the same payload; the row looks and behaves like
 * the widget's checkbox row. If even this fails, the message says the
 * instance should use HTTPS.
 */
export function AltchaFallbackChallenge({
  surface,
  onToken,
  onReady,
}: {
  surface: CaptchaSurface;
  onToken?: (token: string | null) => void;
  onReady?: (handle: CaptchaHandle | null) => void;
}) {
  const t = useT();
  const labelId = useId();
  const [phase, setPhase] = useState<Phase>('verifying');
  const onTokenRef = useLatest(onToken);
  const onReadyRef = useLatest(onReady);
  const startRef = useRef<() => void>(() => {});

  useEffect(() => {
    let token: string | null = null;
    let running: Promise<string | null> | null = null;
    let controller: AbortController | null = null;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const publish = (value: string | null) => {
      if (value === token) return;
      token = value;
      onTokenRef.current?.(value);
    };

    const run = (): Promise<string | null> => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      clearTimeout(expiry);
      publish(null);
      setPhase('verifying');
      const job = (async () => {
        try {
          const response = await fetch(altchaChallengeUrl(surface), {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: current.signal,
          });
          const challenge: unknown = response.ok ? await response.json() : null;
          if (!isSolvableChallenge(challenge)) throw new Error('unsupported challenge');
          const solution = await solveInBackground(challenge, { signal: current.signal });
          if (disposed || current.signal.aborted) return null;
          if (!solution) throw new Error('not solved in time');
          const payload = altchaPayload(challenge, solution);
          publish(payload);
          setPhase('verified');
          const { expiresAt } = challenge.parameters;
          if (typeof expiresAt === 'number') {
            expiry = setTimeout(() => {
              publish(null);
              setPhase('expired');
            }, Math.max(0, expiresAt * 1000 - Date.now()));
          }
          return payload;
        } catch {
          if (disposed || current.signal.aborted) return null;
          setPhase('failed');
          return null;
        }
      })();
      running = job;
      void job.finally(() => {
        if (running === job) running = null;
      });
      return job;
    };

    startRef.current = () => void run();
    // Start before handing out the handle, so an immediate `execute()` joins
    // this run (one solve at a time, never two racing).
    void run();
    const handle: CaptchaHandle = {
      provider: 'altcha',
      surface,
      execute: async () => token ?? (await (running ?? run())),
      // Tokens are single use: solve the next one in the background.
      reset: () => void run(),
    };
    onReadyRef.current?.(handle);
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(expiry);
      onReadyRef.current?.(null);
    };
  }, [surface, onReadyRef, onTokenRef]);

  if (phase === 'failed') {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 text-sm text-text-primary"
      >
        <span className="min-w-0 flex-1 text-pretty">{t('captcha.insecure.failed')}</span>
        <button
          type="button"
          onClick={() => startRef.current()}
          className="shrink-0 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-container focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {t('captcha.challenge.retry')}
        </button>
      </div>
    );
  }

  const verified = phase === 'verified';
  const label =
    phase === 'verified'
      ? t('captcha.altcha.verified')
      : phase === 'expired'
        ? t('captcha.altcha.expired')
        : t('captcha.altcha.verifying');
  return (
    <div
      data-altcha-fallback=""
      style={{ minHeight: ALTCHA_HEIGHT }}
      className="flex items-center gap-2.5 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-text-primary"
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={verified}
        aria-labelledby={labelId}
        aria-busy={phase === 'verifying'}
        aria-disabled={phase !== 'expired'}
        onClick={() => {
          if (phase === 'expired') startRef.current();
        }}
        className={`flex size-[22px] shrink-0 items-center justify-center rounded-[5px] border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
          verified ? 'border-success bg-success text-surface' : 'border-text-muted bg-surface'
        }`}
      >
        {phase === 'verifying' ? (
          <span
            aria-hidden
            className="size-3.5 animate-spin rounded-full border-2 border-primary border-r-transparent motion-reduce:animate-none"
          />
        ) : verified ? (
          <span aria-hidden className="material-symbols-outlined text-base leading-none">
            check
          </span>
        ) : null}
      </button>
      <span id={labelId} aria-live="polite">
        {label}
      </span>
    </div>
  );
}
