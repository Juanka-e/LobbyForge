'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';
import { ALTCHA_HEIGHT, AltchaChallenge } from './AltchaChallenge';
import { AltchaFallbackChallenge } from './AltchaFallbackChallenge';
import { hasWebCrypto } from './altcha-fallback-runner';
import { ChallengeLoadError, ChallengeLoading } from './ChallengeStatus';
import { RecaptchaChallenge } from './RecaptchaChallenge';
import { TurnstileChallenge } from './TurnstileChallenge';
import { useCaptchaConfig } from './useCaptchaConfig';
import type { CaptchaConfig, CaptchaHandle, CaptchaSurface } from './types';

export interface CaptchaChallengeProps {
  surface: CaptchaSurface;
  /**
   * The config, when a parent already has it (`useCaptchaGate`). Leave it
   * out and the challenge fetches its own from `GET /api/auth/captcha`.
   */
  config?: CaptchaConfig | null;
  /** The current token, or null once it expired, was used or failed. */
  onToken?: (token: string | null) => void;
  /** The widget's handle once it can produce tokens; null when it goes away. */
  onReady?: (handle: CaptchaHandle | null) => void;
  /** "Try again" after a load failure — fetch the config again (the server may have switched to ALTCHA). */
  onReload?: () => void;
  /** The widget could not load (script blocked, offline). */
  onLoadError?: () => void;
  className?: string;
}

/**
 * The bot-protection challenge for one surface (docs/CAPTCHA.md §6):
 * ALTCHA (built in), Cloudflare Turnstile or Google reCAPTCHA, whichever
 * the config says to render now. Theme and language follow the page.
 *
 * Remounts (by key) when the provider changes — after
 * `captcha_unavailable` the refetched config names ALTCHA, and the old
 * widget must not keep handing out tokens the server will not take.
 */
export function CaptchaChallenge({
  surface,
  config: given,
  onToken,
  onReady,
  onReload,
  onLoadError,
  className,
}: CaptchaChallengeProps) {
  const t = useT();
  const own = useCaptchaConfig(given === undefined ? surface : null);
  const selfFetching = given === undefined;
  const config = selfFetching ? own.config : given;
  const reload = onReload ?? (selfFetching ? () => void own.refetch() : undefined);
  // Known only in the browser: plain-HTTP pages have no Web Crypto, and
  // ALTCHA's widget cannot run there — our pure-JS solver stands in.
  const [webCrypto, setWebCrypto] = useState<boolean | null>(null);
  useEffect(() => setWebCrypto(hasWebCrypto()), []);

  let body: ReactNode = null;
  if (selfFetching && own.status === 'error') {
    body = <ChallengeLoadError onRetry={() => void own.refetch()} />;
  } else if (!config) {
    body = selfFetching ? <ChallengeLoading minHeight={ALTCHA_HEIGHT} /> : null;
  } else if (config.provider === 'altcha') {
    body =
      webCrypto === null ? (
        <ChallengeLoading minHeight={ALTCHA_HEIGHT} />
      ) : webCrypto ? (
        <AltchaChallenge
          key={`altcha:${surface}`}
          surface={surface}
          onToken={onToken}
          onReady={onReady}
          onLoadError={onLoadError}
        />
      ) : (
        <AltchaFallbackChallenge key={`altcha-js:${surface}`} surface={surface} onToken={onToken} onReady={onReady} />
      );
  } else if (config.provider === 'turnstile' || config.provider === 'recaptcha') {
    if (!config.siteKey) {
      // Misconfigured; the server normally serves ALTCHA instead.
      body = <ChallengeLoadError onRetry={() => reload?.()} />;
    } else if (config.provider === 'turnstile') {
      body = (
        <TurnstileChallenge
          key={`turnstile:${surface}:${config.siteKey}`}
          surface={surface}
          siteKey={config.siteKey}
          appearance={config.options.turnstileAppearance ?? 'interaction-only'}
          onToken={onToken}
          onReady={onReady}
          onReload={reload}
          onLoadError={onLoadError}
        />
      );
    } else {
      const version = config.options.recaptchaVersion ?? 'v3';
      body = (
        <RecaptchaChallenge
          key={`recaptcha:${surface}:${config.siteKey}:${version}`}
          surface={surface}
          siteKey={config.siteKey}
          version={version}
          onToken={onToken}
          onReady={onReady}
          onReload={reload}
          onLoadError={onLoadError}
        />
      );
    }
  }

  if (!body) return null;
  return (
    <div
      role="group"
      aria-label={t('captcha.challenge.label')}
      data-captcha-provider={config?.provider ?? 'pending'}
      className={className ?? 'grid gap-2'}
    >
      {body}
    </div>
  );
}
