/**
 * Bot protection, browser side — the shapes of docs/CAPTCHA.md §4 and §6.
 *
 * The server owns verification (`lib/captcha/`); this module only knows the
 * public HTTP contract: the config a page asks for, the fields a protected
 * form sends back, and the refusals it can get.
 */

export type CaptchaSurface = 'register' | 'invite_register' | 'guest' | 'login';
export type CaptchaProvider = 'none' | 'altcha' | 'turnstile' | 'recaptcha';
export type RecaptchaVersion = 'v2_checkbox' | 'v2_invisible' | 'v3';
export type TurnstileAppearance = 'always' | 'interaction-only';

/** `GET /api/auth/captcha?surface=…` (§4.1). */
export interface CaptchaConfig {
  surface: CaptchaSurface;
  /** False when the surface is off, and for adaptive sign-in until it asks. */
  required: boolean;
  mode: 'on' | 'off' | 'adaptive' | 'always';
  /** What to render NOW — `altcha` while the external-provider breaker is open. */
  provider: CaptchaProvider;
  siteKey: string | null;
  options: {
    turnstileAppearance?: TurnstileAppearance;
    recaptchaVersion?: RecaptchaVersion;
  };
  /** Backs the minimum-fill-time check (register, invite_register, guest). */
  formToken: string | null;
}

/** The optional body fields every protected route accepts (§4.3). */
export interface CaptchaFields {
  captchaToken?: string;
  captchaProvider?: CaptchaProvider;
  formToken?: string;
  /** The honeypot — only ever sent when something filled it. */
  website?: string;
}

/** The HTTP 400 `error` codes of §4.4. */
export const CAPTCHA_REFUSALS = ['captcha_required', 'captcha_invalid', 'captcha_unavailable', 'form_rejected'] as const;
export type CaptchaRefusal = (typeof CAPTCHA_REFUSALS)[number];

/** What a rendered challenge exposes to the form around it. */
export interface CaptchaHandle {
  provider: Exclude<CaptchaProvider, 'none'>;
  /** Tokens are bound to their surface (an ALTCHA salt, a Turnstile action). */
  surface: CaptchaSurface;
  /**
   * A fresh token: the one the widget already has, or the result of running
   * it now (ALTCHA's proof of work, reCAPTCHA v3/invisible, a pending
   * Turnstile run). `null` when the person still has to act (a v2 checkbox,
   * an interactive Turnstile) or the widget failed.
   */
  execute: () => Promise<string | null>;
  /** Tokens are single use: start over after every request that sent one. */
  reset: () => void;
}

/** The token cap of §4.3 — anything longer is refused by the server anyway. */
export const MAX_TOKEN_LENGTH = 4096;

const SURFACES: readonly CaptchaSurface[] = ['register', 'invite_register', 'guest', 'login'];
const PROVIDERS: readonly CaptchaProvider[] = ['none', 'altcha', 'turnstile', 'recaptcha'];
const MODES: readonly CaptchaConfig['mode'][] = ['on', 'off', 'adaptive', 'always'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a config answer defensively: anything malformed is `null`, and the
 * page then behaves as if protection were unknown (it sends no captcha
 * fields and reacts to a refusal instead).
 */
export function parseCaptchaConfig(raw: unknown): CaptchaConfig | null {
  if (!isRecord(raw)) return null;
  const { surface, required, mode, provider, siteKey, options, formToken } = raw;
  if (typeof surface !== 'string' || !SURFACES.includes(surface as CaptchaSurface)) return null;
  if (typeof provider !== 'string' || !PROVIDERS.includes(provider as CaptchaProvider)) return null;
  const opts = isRecord(options) ? options : {};
  const appearance = opts.turnstileAppearance === 'always' || opts.turnstileAppearance === 'interaction-only'
    ? opts.turnstileAppearance
    : undefined;
  const version = opts.recaptchaVersion === 'v2_checkbox' || opts.recaptchaVersion === 'v2_invisible' || opts.recaptchaVersion === 'v3'
    ? opts.recaptchaVersion
    : undefined;
  return {
    surface: surface as CaptchaSurface,
    required: required === true,
    mode: typeof mode === 'string' && MODES.includes(mode as CaptchaConfig['mode']) ? (mode as CaptchaConfig['mode']) : 'on',
    provider: provider as CaptchaProvider,
    siteKey: typeof siteKey === 'string' && siteKey.trim() ? siteKey : null,
    options: { turnstileAppearance: appearance, recaptchaVersion: version },
    formToken: typeof formToken === 'string' && formToken ? formToken : null,
  };
}

/** The §4.4 code in a refusal body, if it is one. */
export function captchaRefusalOf(body: unknown): CaptchaRefusal | null {
  if (!isRecord(body) || typeof body.error !== 'string') return null;
  return (CAPTCHA_REFUSALS as readonly string[]).includes(body.error) ? (body.error as CaptchaRefusal) : null;
}

/**
 * The refusal code of a response, reading a CLONE so the caller can still
 * read the body. Refusals are always HTTP 400 JSON.
 */
export async function readCaptchaRefusal(response: Response): Promise<CaptchaRefusal | null> {
  if (response.status !== 400) return null;
  const body: unknown = await response.clone().json().catch(() => null);
  return captchaRefusalOf(body);
}

/** Whether a config needs a widget at all. */
export function needsWidget(config: CaptchaConfig | null): boolean {
  return Boolean(config && config.provider !== 'none');
}
