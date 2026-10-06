/**
 * Bot protection (docs/CAPTCHA.md) — the shared vocabulary: surfaces, modes,
 * providers, options and their defaults, the verification verdicts and the
 * refusal codes. Client-safe (no Node imports): the admin card and the
 * challenge component may import the types and defaults from here.
 */
import { z } from 'zod';

export const CAPTCHA_SURFACES = ['register', 'invite_register', 'guest', 'login', 'password_reset'] as const;
export type CaptchaSurface = (typeof CAPTCHA_SURFACES)[number];
/** The surfaces whose mode is a plain on/off switch (and that get a `formToken`). */
export type FormCaptchaSurface = Exclude<CaptchaSurface, 'login'>;

export const CAPTCHA_PROVIDERS = ['none', 'altcha', 'turnstile', 'recaptcha'] as const;
export type CaptchaProvider = (typeof CAPTCHA_PROVIDERS)[number];
export type ExternalCaptchaProvider = 'turnstile' | 'recaptcha';
/** A provider that can produce a token (`captchaProvider` in a request body). */
export type TokenCaptchaProvider = Exclude<CaptchaProvider, 'none'>;

export type ToggleMode = 'on' | 'off';
export type LoginMode = 'off' | 'adaptive' | 'always';
export type SurfaceMode = ToggleMode | LoginMode;

export interface CaptchaSurfaces {
  register: ToggleMode;
  invite_register: ToggleMode;
  guest: ToggleMode;
  login: LoginMode;
  /** The forgot-password form (docs/EMAIL.md §4.3), default on. */
  password_reset: ToggleMode;
}

export const DEFAULT_CAPTCHA_SURFACES: Readonly<CaptchaSurfaces> = Object.freeze({
  register: 'on',
  invite_register: 'off',
  guest: 'on',
  login: 'adaptive',
  password_reset: 'on',
});

export type AltchaDifficulty = 'normal' | 'hard';
export type TurnstileAppearance = 'always' | 'interaction-only';
export type RecaptchaVersion = 'v2_checkbox' | 'v2_invisible' | 'v3';

/** `captcha_options` with every default filled in (§3.1). */
export interface CaptchaOptions {
  altchaDifficulty: AltchaDifficulty;
  turnstileAppearance: TurnstileAppearance;
  recaptchaVersion: RecaptchaVersion;
  recaptchaMinScore: number;
  loginFailureThreshold: number;
}

export const DEFAULT_CAPTCHA_OPTIONS: Readonly<CaptchaOptions> = Object.freeze({
  altchaDifficulty: 'normal',
  turnstileAppearance: 'interaction-only',
  recaptchaVersion: 'v3',
  recaptchaMinScore: 0.5,
  loginFailureThreshold: 3,
});

const ToggleModeSchema = z.enum(['on', 'off']);
const LoginModeSchema = z.enum(['off', 'adaptive', 'always']);

export const CaptchaSurfacesSchema = z
  .object({
    register: ToggleModeSchema,
    invite_register: ToggleModeSchema,
    guest: ToggleModeSchema,
    login: LoginModeSchema,
    // Added with email (docs/EMAIL.md §4.3). Optional on write so a client
    // that predates it keeps the stored value (the admin update merges).
    password_reset: ToggleModeSchema.optional(),
  })
  .strict();

const OPTION_SCHEMAS = {
  altchaDifficulty: z.enum(['normal', 'hard']),
  turnstileAppearance: z.enum(['always', 'interaction-only']),
  recaptchaVersion: z.enum(['v2_checkbox', 'v2_invisible', 'v3']),
  // One decimal place, like Google's own score buckets.
  recaptchaMinScore: z.number().min(0.1).max(0.9).multipleOf(0.1),
  loginFailureThreshold: z.number().int().min(1).max(10),
} as const;

/** The write schema for `captcha_options`: every key optional, nothing else allowed. */
export const CaptchaOptionsSchema = z
  .object({
    altchaDifficulty: OPTION_SCHEMAS.altchaDifficulty.optional(),
    turnstileAppearance: OPTION_SCHEMAS.turnstileAppearance.optional(),
    recaptchaVersion: OPTION_SCHEMAS.recaptchaVersion.optional(),
    recaptchaMinScore: OPTION_SCHEMAS.recaptchaMinScore.optional(),
    loginFailureThreshold: OPTION_SCHEMAS.loginFailureThreshold.optional(),
  })
  .strict();

/**
 * Stored surfaces → a complete, valid set. Tolerant on read: a key that is
 * missing or holds an unknown value gets its default (the column is written
 * only through the validated admin API, so this is a safety net).
 */
export function parseCaptchaSurfaces(raw: unknown): CaptchaSurfaces {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const toggle = (key: Exclude<keyof CaptchaSurfaces, 'login'>): ToggleMode => {
    const parsed = ToggleModeSchema.safeParse(source[key]);
    return parsed.success ? parsed.data : DEFAULT_CAPTCHA_SURFACES[key];
  };
  const login = LoginModeSchema.safeParse(source.login);
  return {
    register: toggle('register'),
    invite_register: toggle('invite_register'),
    guest: toggle('guest'),
    login: login.success ? login.data : DEFAULT_CAPTCHA_SURFACES.login,
    password_reset: toggle('password_reset'),
  };
}

/** Stored options → every key present: valid stored values kept, the rest defaulted. */
export function fillCaptchaOptions(raw: unknown): CaptchaOptions {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_CAPTCHA_OPTIONS } as Record<keyof CaptchaOptions, unknown>;
  for (const key of Object.keys(OPTION_SCHEMAS) as Array<keyof CaptchaOptions>) {
    const parsed = OPTION_SCHEMAS[key].safeParse(source[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as unknown as CaptchaOptions;
}

export function isCaptchaSurface(value: unknown): value is CaptchaSurface {
  return typeof value === 'string' && (CAPTCHA_SURFACES as readonly string[]).includes(value);
}

export function isCaptchaProvider(value: unknown): value is CaptchaProvider {
  return typeof value === 'string' && (CAPTCHA_PROVIDERS as readonly string[]).includes(value);
}

export function isExternalProvider(value: unknown): value is ExternalCaptchaProvider {
  return value === 'turnstile' || value === 'recaptcha';
}

/** `verifyCaptcha`'s result (§5). */
export type CaptchaVerdict = 'ok' | 'missing' | 'invalid' | 'expired' | 'duplicate' | 'unavailable' | 'misconfigured';

/** The `error` of a refused protected request (§4.4) — always HTTP 400. */
export type CaptchaRefusalCode = 'captcha_required' | 'captcha_invalid' | 'captcha_unavailable' | 'form_rejected';

export const CAPTCHA_TOKEN_MAX_LENGTH = 4096;

/**
 * The optional body fields every protected route accepts (§4.3). Spread into
 * the route's own `.strict()` schema, so nothing else gets in.
 */
export const CaptchaBodyFields = {
  captchaToken: z.string().max(CAPTCHA_TOKEN_MAX_LENGTH).optional(),
  captchaProvider: z.enum(['altcha', 'turnstile', 'recaptcha']).optional(),
  formToken: z.string().max(256).optional(),
  // The honeypot: anything but empty or absent is refused (form_rejected),
  // so a bot that fills it gets the generic answer, not a validation error.
  website: z.string().max(1024).optional(),
} as const;

export interface CaptchaBody {
  captchaToken?: string;
  captchaProvider?: TokenCaptchaProvider;
  formToken?: string;
  website?: string;
}
