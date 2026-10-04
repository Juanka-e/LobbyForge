/**
 * The CSP side of bot protection (docs/CAPTCHA.md §9), for `middleware.ts`.
 *
 * ALTCHA needs no origin. An external provider's origins are added to every
 * HTML page response (never API routes or static files), and only while
 * that provider is the configured one with both keys in place. Every page,
 * not just the ones that render the widget: a client-side navigation
 * (`next/link`, `/home` → `/login`, `/lobby` opening the guest dialog) keeps
 * the CSP of the document it started on, so a widget page reached that way
 * would otherwise run under a policy without the provider. The origins:
 *   - Turnstile: https://challenges.cloudflare.com (script-src, frame-src);
 *   - reCAPTCHA: https://www.google.com/recaptcha/ and
 *     https://www.gstatic.com/recaptcha/ (script-src),
 *     https://www.google.com/recaptcha/ and https://recaptcha.google.com/recaptcha/
 *     (frame-src), https://www.google.com/recaptcha/ (connect-src) — Google's
 *     published list.
 *
 * How the middleware knows the provider: it runs in the Node.js runtime
 * (`config.runtime = 'nodejs'` in middleware.ts), so it reads the same
 * per-process settings cache the routes use (`resolveCaptchaSettings`, on
 * `globalThis`, 5 s TTL; a save through the admin API invalidates it). Page
 * requests never wait on the database once the process has read it once:
 * they get the last known value while a background refresh runs (see
 * `cspCaptchaProvider`). Only the first lookup waits, capped at
 * `CSP_LOOKUP_TIMEOUT_MS`; past that, the environment override is used, or
 * no external origin at all (fail closed: the page then falls back to what
 * the public config serves).
 */
import {
  captchaSettingsSnapshot,
  externalProviderConfigured,
  readCaptchaEnvOverrides,
  resolveCaptchaSettings,
  type ResolvedCaptchaSettings,
} from './settings';
import type { CaptchaProvider } from './types';

export const CSP_LOOKUP_TIMEOUT_MS = 750;

export interface CaptchaCspSources {
  script: string[];
  frame: string[];
  connect: string[];
}

const NONE: CaptchaCspSources = Object.freeze({ script: [], frame: [], connect: [] }) as CaptchaCspSources;

export const CAPTCHA_CSP_SOURCES: Record<'turnstile' | 'recaptcha', CaptchaCspSources> = {
  turnstile: {
    script: ['https://challenges.cloudflare.com'],
    frame: ['https://challenges.cloudflare.com'],
    connect: [],
  },
  recaptcha: {
    script: ['https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/'],
    frame: ['https://www.google.com/recaptcha/', 'https://recaptcha.google.com/recaptcha/'],
    connect: ['https://www.google.com/recaptcha/'],
  },
};

/** A file name at the end of the path (`/icon.svg`, `/manifest.webmanifest`): a static file, not a page. */
const FILE_PATH = /\/[^/]*\.[A-Za-z0-9]+$/;

/**
 * Whether a request path can be an HTML page: anything but API routes,
 * Next's own assets and static files. (The middleware matcher already skips
 * `_next/static`, `_next/image` and a few root files.)
 */
export function isCaptchaPagePath(pathname: string): boolean {
  if (pathname === '/api' || pathname.startsWith('/api/')) return false;
  if (pathname.startsWith('/_next/')) return false;
  return !FILE_PATH.test(pathname);
}

export function captchaCspSourcesFor(provider: CaptchaProvider | null): CaptchaCspSources {
  return provider === 'turnstile' || provider === 'recaptcha' ? CAPTCHA_CSP_SOURCES[provider] : NONE;
}

/** After a cold lookup timed out, page requests do not wait again for this long. */
const COLD_LOOKUP_BACKOFF_MS = 5_000;
const BACKOFF_KEY = '__lobbyforgeCaptchaCspBackoff__';

function backoffHolder(): { until: number } {
  const g = globalThis as unknown as Record<string, { until: number } | undefined>;
  let holder = g[BACKOFF_KEY];
  if (!holder) {
    holder = { until: 0 };
    g[BACKOFF_KEY] = holder;
  }
  return holder;
}

function providerOf(settings: ResolvedCaptchaSettings): CaptchaProvider | null {
  return externalProviderConfigured(settings) ? settings.provider : null;
}

function envProvider(): CaptchaProvider | null {
  const env = readCaptchaEnvOverrides();
  return env.provider && env.siteKey && env.secretKey ? env.provider : null;
}

/** A stale value gets this long for its refresh before the page goes out with it. */
export const CSP_STALE_REFRESH_WAIT_MS = 300;

/** The settings within `ms`, `'timeout'` past it; a failed read counts as a timeout. */
async function settingsWithin(ms: number): Promise<ResolvedCaptchaSettings | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([resolveCaptchaSettings(), timeout]);
  } catch {
    return 'timeout';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The external provider whose origins the pages need right now, or null.
 *
 * - A value younger than the 5 s TTL is used as is.
 * - An older one gets a short, capped refresh (`CSP_STALE_REFRESH_WAIT_MS`,
 *   deduplicated with every other reader). Otherwise the first page after
 *   a provider change saved in ANOTHER process would still carry the old
 *   policy, while the config API already names the new provider, and that
 *   visitor's widget would be blocked.
 * - If the refresh misses the cap (slow or hung database), the page goes
 *   out with the last known value. For 5 s, pages stop waiting at all and
 *   only refresh in the background.
 * - The very first lookup of a process has no last known value. It waits
 *   up to `CSP_LOOKUP_TIMEOUT_MS`, then falls back to the environment
 *   override (or nothing) under the same 5 s backoff.
 */
export async function cspCaptchaProvider(): Promise<CaptchaProvider | null> {
  const { lastGood, fresh } = captchaSettingsSnapshot();
  if (lastGood && fresh) return providerOf(lastGood);
  const backoff = backoffHolder();
  if (backoff.until > Date.now()) {
    void resolveCaptchaSettings().catch(() => undefined);
    return lastGood ? providerOf(lastGood) : envProvider();
  }
  const result = await settingsWithin(lastGood ? CSP_STALE_REFRESH_WAIT_MS : CSP_LOOKUP_TIMEOUT_MS);
  if (result !== 'timeout') return providerOf(result);
  backoff.until = Date.now() + COLD_LOOKUP_BACKOFF_MS;
  return lastGood ? providerOf(lastGood) : envProvider();
}

/** The extra CSP sources for a request path: the active external provider's on pages, none elsewhere. */
export async function captchaCspSourcesForPath(pathname: string): Promise<CaptchaCspSources> {
  if (!isCaptchaPagePath(pathname)) return NONE;
  return captchaCspSourcesFor(await cspCaptchaProvider());
}
