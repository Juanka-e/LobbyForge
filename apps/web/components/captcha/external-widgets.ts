import { useEffect, useState } from 'react';

/**
 * The two external providers' browser APIs, typed to the parts we use,
 * and the URLs and parameters we load them with.
 *
 * CSP (docs/CAPTCHA.md §9): the `<script>` tag itself is admitted by the
 * page nonce; the provider's frames and any scripts it loads in turn need
 * its origins in `frame-src` / `script-src` on the pages that render a
 * widget, which the server adds while that provider is active.
 */

export interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  theme?: 'light' | 'dark' | 'auto';
  language?: string;
  appearance?: 'always' | 'execute' | 'interaction-only';
  size?: 'normal' | 'flexible' | 'compact';
  'response-field'?: boolean;
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: (code?: string) => boolean | void;
  'timeout-callback'?: () => void;
  'before-interactive-callback'?: () => void;
  'after-interactive-callback'?: () => void;
}

export interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string | undefined;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

export interface RecaptchaRenderOptions {
  sitekey: string;
  theme?: 'light' | 'dark';
  size?: 'normal' | 'compact' | 'invisible';
  badge?: 'bottomright' | 'bottomleft' | 'inline';
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
}

export interface RecaptchaApi {
  ready: (callback: () => void) => void;
  render: (container: HTMLElement, options: RecaptchaRenderOptions) => number;
  reset: (widgetId?: number) => void;
  /** v3: `(siteKey, { action })` → token. v2 invisible: `(widgetId)` → token via the callback. */
  execute: (widgetIdOrSiteKey?: number | string, options?: { action: string }) => PromiseLike<string> | void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    grecaptcha?: RecaptchaApi;
  }
}

export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Where each provider's frames and follow-up scripts come from. */
export const TURNSTILE_ORIGINS = ['https://challenges.cloudflare.com'] as const;
export const RECAPTCHA_ORIGINS = ['https://www.google.com/recaptcha', 'https://www.gstatic.com/recaptcha'] as const;

/**
 * Whether this document's CSP refused one of `origins`. The provider's
 * origins are added per page by the server, but a client-side navigation
 * keeps the CSP of the page the visit started on — so a widget reached
 * that way can be blocked, and only a full reload (a new document with
 * this page's policy) fixes it.
 */
export function useCspBlocked(origins: readonly string[]): boolean {
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const onViolation = (event: Event) => {
      const uri = (event as SecurityPolicyViolationEvent).blockedURI ?? '';
      if (origins.some((origin) => uri.startsWith(origin))) setBlocked(true);
    };
    document.addEventListener('securitypolicyviolation', onViolation);
    return () => document.removeEventListener('securitypolicyviolation', onViolation);
  }, [origins]);
  return blocked;
}

/** v2 renders explicitly; v3 loads with its site key and has no widget. */
export function recaptchaScriptUrl(version: 'v2' | 'v3', siteKey: string, locale: string): string {
  const render = version === 'v3' ? encodeURIComponent(siteKey) : 'explicit';
  return `https://www.google.com/recaptcha/api.js?render=${render}&hl=${encodeURIComponent(locale)}`;
}

/** Languages Turnstile's widget speaks; anything else lets it pick (`auto`). */
const TURNSTILE_LANGUAGES = new Set([
  'ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fr', 'he', 'hi', 'hr', 'hu', 'id', 'it', 'ja', 'ko',
  'lt', 'ms', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'th', 'tl', 'tr', 'uk', 'vi', 'zh',
]);
const TURNSTILE_REGIONAL = new Set(['pt-br', 'zh-cn', 'zh-tw', 'ar-eg']);

export function turnstileLanguage(locale: string): string {
  const lower = locale.toLowerCase();
  if (TURNSTILE_REGIONAL.has(lower)) return lower;
  const base = lower.split('-')[0] ?? '';
  return TURNSTILE_LANGUAGES.has(base) ? base : 'auto';
}

/**
 * reCAPTCHA v3 and v2 invisible float a badge over the page's corner, on
 * top of the lobby's own controls. Google allows hiding it when the page
 * shows its attribution text instead, which `RecaptchaChallenge` does.
 */
export function hideRecaptchaBadge(nonce?: string): void {
  if (document.getElementById('lf-recaptcha-badge')) return;
  const style = document.createElement('style');
  style.id = 'lf-recaptcha-badge';
  if (nonce) style.nonce = nonce;
  style.textContent = '.grecaptcha-badge{visibility:hidden}';
  document.head.appendChild(style);
}
