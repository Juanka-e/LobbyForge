/**
 * The admin side of bot protection: the `GET`/`PUT /api/admin/captcha`
 * and `POST /api/admin/captcha/test` shapes of docs/CAPTCHA.md §6.1, and
 * the pure logic the "Bot protection" card runs on them.
 */

export type CaptchaProviderChoice = 'none' | 'altcha' | 'turnstile' | 'recaptcha';
export type ExternalProvider = 'turnstile' | 'recaptcha';
export type OnOff = 'on' | 'off';
export type LoginMode = 'off' | 'adaptive' | 'always';
export type RecaptchaVersion = 'v2_checkbox' | 'v2_invisible' | 'v3';

export interface CaptchaSurfaces {
  register: OnOff;
  invite_register: OnOff;
  guest: OnOff;
  login: LoginMode;
}

export interface CaptchaOptions {
  altchaDifficulty: 'normal' | 'hard';
  turnstileAppearance: 'always' | 'interaction-only';
  recaptchaVersion: RecaptchaVersion;
  recaptchaMinScore: number;
  loginFailureThreshold: number;
}

/** `GET /api/admin/captcha` — and what `PUT` answers with. */
export interface AdminCaptchaSettings {
  provider: CaptchaProviderChoice;
  surfaces: CaptchaSurfaces;
  siteKey: string | null;
  secretSet: boolean;
  secretHint: string | null;
  options: CaptchaOptions;
  attackMode: { manual: boolean; autoUntil: string | null };
  locked: { provider: boolean; siteKey: boolean; secretKey: boolean };
  breaker: { open: boolean; until: string | null };
}

/** What the card edits. The secret is never part of it — see `SecretAction`. */
export interface CaptchaDraft {
  provider: CaptchaProviderChoice;
  surfaces: CaptchaSurfaces;
  siteKey: string;
  options: CaptchaOptions;
  attackMode: boolean;
}

/** The secret is write-only: keep the saved one, replace it, or clear it. */
export type SecretAction = { kind: 'keep' } | { kind: 'replace'; value: string } | { kind: 'clear' };

export type CaptchaTestResult = 'ok' | 'bad_secret' | 'unreachable' | 'missing_keys' | 'not_applicable';

/** The environment variables that lock each field (§3.2). */
export const LOCK_ENV: Record<keyof AdminCaptchaSettings['locked'], string> = {
  provider: 'LOBBYFORGE_CAPTCHA_PROVIDER',
  siteKey: 'LOBBYFORGE_CAPTCHA_SITE_KEY',
  secretKey: 'LOBBYFORGE_CAPTCHA_SECRET_KEY',
};

export const DEFAULT_OPTIONS: CaptchaOptions = {
  altchaDifficulty: 'normal',
  turnstileAppearance: 'interaction-only',
  recaptchaVersion: 'v3',
  recaptchaMinScore: 0.5,
  loginFailureThreshold: 3,
};

export const DEFAULT_SURFACES: CaptchaSurfaces = {
  register: 'on',
  invite_register: 'off',
  guest: 'on',
  login: 'adaptive',
};

export const MIN_SCORE = { min: 0.1, max: 0.9, step: 0.1 } as const;
export const THRESHOLD = { min: 1, max: 10 } as const;

export function isExternal(provider: CaptchaProviderChoice): provider is ExternalProvider {
  return provider === 'turnstile' || provider === 'recaptcha';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** Read the admin API's answer, filling defaults; `null` when it is not that shape at all. */
export function parseAdminCaptchaSettings(raw: unknown): AdminCaptchaSettings | null {
  if (!isRecord(raw) || typeof raw.provider !== 'string') return null;
  const surfaces = isRecord(raw.surfaces) ? raw.surfaces : {};
  const options = isRecord(raw.options) ? raw.options : {};
  const attack = isRecord(raw.attackMode) ? raw.attackMode : {};
  const locked = isRecord(raw.locked) ? raw.locked : {};
  const breaker = isRecord(raw.breaker) ? raw.breaker : {};
  return {
    provider: oneOf(raw.provider, ['none', 'altcha', 'turnstile', 'recaptcha'] as const, 'altcha'),
    surfaces: {
      register: oneOf(surfaces.register, ['on', 'off'] as const, DEFAULT_SURFACES.register),
      invite_register: oneOf(surfaces.invite_register, ['on', 'off'] as const, DEFAULT_SURFACES.invite_register),
      guest: oneOf(surfaces.guest, ['on', 'off'] as const, DEFAULT_SURFACES.guest),
      login: oneOf(surfaces.login, ['off', 'adaptive', 'always'] as const, DEFAULT_SURFACES.login),
    },
    siteKey: typeof raw.siteKey === 'string' && raw.siteKey ? raw.siteKey : null,
    secretSet: raw.secretSet === true,
    secretHint: typeof raw.secretHint === 'string' && raw.secretHint ? raw.secretHint : null,
    options: {
      altchaDifficulty: oneOf(options.altchaDifficulty, ['normal', 'hard'] as const, DEFAULT_OPTIONS.altchaDifficulty),
      turnstileAppearance: oneOf(
        options.turnstileAppearance,
        ['always', 'interaction-only'] as const,
        DEFAULT_OPTIONS.turnstileAppearance
      ),
      recaptchaVersion: oneOf(options.recaptchaVersion, ['v2_checkbox', 'v2_invisible', 'v3'] as const, DEFAULT_OPTIONS.recaptchaVersion),
      recaptchaMinScore: clampNumber(options.recaptchaMinScore, MIN_SCORE.min, MIN_SCORE.max, DEFAULT_OPTIONS.recaptchaMinScore),
      loginFailureThreshold: Math.round(
        clampNumber(options.loginFailureThreshold, THRESHOLD.min, THRESHOLD.max, DEFAULT_OPTIONS.loginFailureThreshold)
      ),
    },
    attackMode: { manual: attack.manual === true, autoUntil: isoOrNull(attack.autoUntil) },
    locked: { provider: locked.provider === true, siteKey: locked.siteKey === true, secretKey: locked.secretKey === true },
    breaker: { open: breaker.open === true, until: isoOrNull(breaker.until) },
  };
}

export function draftFrom(settings: AdminCaptchaSettings): CaptchaDraft {
  return {
    provider: settings.provider,
    surfaces: { ...settings.surfaces },
    siteKey: settings.siteKey ?? '',
    options: { ...settings.options },
    attackMode: settings.attackMode.manual,
  };
}

function normalizedDraft(draft: CaptchaDraft): CaptchaDraft {
  return { ...draft, siteKey: draft.siteKey.trim() };
}

export function isDirty(saved: AdminCaptchaSettings, draft: CaptchaDraft, secret: SecretAction): boolean {
  if (secret.kind === 'clear' || (secret.kind === 'replace' && secret.value.trim())) return true;
  return JSON.stringify(normalizedDraft(draftFrom(saved))) !== JSON.stringify(normalizedDraft(draft));
}

/**
 * Whether an external provider would be saved without both keys — the
 * server refuses that (`keys_required`); the card says so first.
 */
export function missingKeys(saved: AdminCaptchaSettings, draft: CaptchaDraft, secret: SecretAction): boolean {
  if (!isExternal(draft.provider)) return false;
  const hasSiteKey = saved.locked.siteKey || draft.siteKey.trim().length > 0;
  const hasSecret =
    saved.locked.secretKey ||
    (secret.kind === 'replace' && secret.value.trim().length > 0) ||
    (secret.kind === 'keep' && saved.secretSet);
  return !hasSiteKey || !hasSecret;
}

/**
 * The `PUT` body. Locked fields are left out — except the provider, which
 * the contract requires: a locked one goes back unchanged. The secret is
 * a string to set, `null` to clear, absent to keep.
 */
export function buildPutBody(saved: AdminCaptchaSettings, draft: CaptchaDraft, secret: SecretAction): Record<string, unknown> {
  const body: Record<string, unknown> = {
    provider: saved.locked.provider ? saved.provider : draft.provider,
    surfaces: draft.surfaces,
    options: draft.options,
    attackMode: draft.attackMode,
  };
  if (!saved.locked.siteKey) body.siteKey = draft.siteKey.trim() || null;
  if (!saved.locked.secretKey) {
    if (secret.kind === 'clear') body.secretKey = null;
    else if (secret.kind === 'replace' && secret.value.trim()) body.secretKey = secret.value.trim();
  }
  return body;
}

/** The test call: the unsaved values where there are any, the saved ones otherwise. */
export function buildTestBody(saved: AdminCaptchaSettings, draft: CaptchaDraft, secret: SecretAction): Record<string, unknown> {
  const body: Record<string, unknown> = { provider: draft.provider };
  if (!saved.locked.siteKey && draft.siteKey.trim()) body.siteKey = draft.siteKey.trim();
  if (!saved.locked.secretKey && secret.kind === 'replace' && secret.value.trim()) body.secretKey = secret.value.trim();
  return body;
}

export function parseTestResult(raw: unknown): { result: CaptchaTestResult; detail: string | null } | null {
  if (!isRecord(raw)) return null;
  const result = oneOf(raw.result, ['ok', 'bad_secret', 'unreachable', 'missing_keys', 'not_applicable'] as const, 'unreachable');
  if (raw.result !== result) return null;
  return { result, detail: typeof raw.detail === 'string' && raw.detail ? raw.detail : null };
}

/** A timestamp still in the future (automatic attack mode, the breaker). */
export function isFuture(iso: string | null, now: number = Date.now()): iso is string {
  return iso !== null && Date.parse(iso) > now;
}
