/**
 * The effective bot protection settings (docs/CAPTCHA.md §3): the stored
 * row (migration 0045) with the environment overrides on top (§3.2), the
 * defaults filled in and the secret decrypted. Server-only.
 *
 *   LOBBYFORGE_CAPTCHA_PROVIDER    none | altcha | turnstile | recaptcha
 *                                  (`none` is the emergency switch)
 *   LOBBYFORGE_CAPTCHA_SITE_KEY    public site key of the external provider
 *   LOBBYFORGE_CAPTCHA_SECRET_KEY  its secret key (plaintext in the env;
 *                                  never stored, never returned)
 *
 * The result is cached per process for 5 s (on `globalThis`, so the routes
 * and the CSP middleware share it) — every protected request, the public
 * config and the middleware read it. A save through the admin API
 * invalidates the cache of the process that handled it (a generation
 * counter keeps a read that started before the save from putting old values
 * back); other processes catch up within the TTL.
 *
 * When the row cannot be read, the defaults apply (the built-in ALTCHA,
 * sign-up and new guests protected): protection never silently turns off
 * because the database hiccupped. That answer is cached for 3 s and the
 * error logged at most once a minute.
 */
import { getInstanceCaptchaSettings, type InstanceCaptchaSettings } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { decryptCaptchaSecret, captchaSecretHint } from './secret';
import {
  DEFAULT_CAPTCHA_OPTIONS,
  DEFAULT_CAPTCHA_SURFACES,
  fillCaptchaOptions,
  isCaptchaProvider,
  isExternalProvider,
  parseCaptchaSurfaces,
  type CaptchaOptions,
  type CaptchaProvider,
  type CaptchaSurfaces,
} from './types';

export type CaptchaSecretState = 'unset' | 'ok' | 'undecryptable';

export interface CaptchaEnvOverrides {
  provider: CaptchaProvider | null;
  /** A value is set but is not one of the four providers (ignored; Doctor warns). */
  invalidProvider: string | null;
  siteKey: string | null;
  secretKey: string | null;
}

export interface ResolvedCaptchaSettings {
  /** The provider in force: the env override, else the stored one. */
  provider: CaptchaProvider;
  surfaces: CaptchaSurfaces;
  /** Effective site key (env, else stored). */
  siteKey: string | null;
  /** Effective secret, decrypted. Server-only — never serialise this object to a client. */
  secretKey: string | null;
  secretState: CaptchaSecretState;
  secretHint: string | null;
  options: CaptchaOptions;
  /** The admin's manual attack-mode switch. */
  attackModeManual: boolean;
  locked: { provider: boolean; siteKey: boolean; secretKey: boolean };
  env: CaptchaEnvOverrides;
  /** The row as stored (secret still encrypted) — the admin PUT diffs against it. */
  stored: InstanceCaptchaSettings;
  /** False when the row could not be read and the defaults stand in for it. */
  loaded: boolean;
}

const CACHE_KEY = '__lobbyforgeCaptchaSettings__';
const CACHE_TTL_MS = 5_000;
/** A failed read is remembered this long, so a hanging database is not asked on every request. */
const FAILURE_TTL_MS = 3_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

interface CacheSlot {
  value: ResolvedCaptchaSettings;
  expiresAt: number;
}

interface CacheHolder {
  /** The current answer (a failed read too, for FAILURE_TTL_MS). */
  slot?: CacheSlot;
  pending?: Promise<ResolvedCaptchaSettings>;
  /** Bumped by every invalidation: a read started before a save never fills the cache. */
  generation: number;
  /** The last settings actually read from the database (any age) — the CSP middleware serves it while refreshing. */
  lastGood?: ResolvedCaptchaSettings;
  lastErrorLogAt?: number;
}

function cacheSlot(): CacheHolder {
  const g = globalThis as unknown as Record<string, CacheHolder | undefined>;
  let holder = g[CACHE_KEY];
  if (!holder) {
    holder = { generation: 0 };
    g[CACHE_KEY] = holder;
  }
  return holder;
}

let warnedInvalidProvider = false;

function envValue(name: string): string | null {
  const raw = process.env[name];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

export function readCaptchaEnvOverrides(): CaptchaEnvOverrides {
  const rawProvider = envValue('LOBBYFORGE_CAPTCHA_PROVIDER')?.toLowerCase() ?? null;
  const provider = rawProvider && isCaptchaProvider(rawProvider) ? rawProvider : null;
  const invalidProvider = rawProvider && !provider ? rawProvider : null;
  if (invalidProvider && !warnedInvalidProvider) {
    warnedInvalidProvider = true;
    console.warn(`[captcha] LOBBYFORGE_CAPTCHA_PROVIDER=${JSON.stringify(invalidProvider)} is not one of none, altcha, turnstile, recaptcha — ignored.`);
  }
  return {
    provider,
    invalidProvider,
    siteKey: envValue('LOBBYFORGE_CAPTCHA_SITE_KEY'),
    secretKey: envValue('LOBBYFORGE_CAPTCHA_SECRET_KEY'),
  };
}

function defaultStored(): InstanceCaptchaSettings {
  return {
    instanceId: 'self-host',
    provider: 'altcha',
    surfaces: { ...DEFAULT_CAPTCHA_SURFACES },
    siteKey: null,
    secretEncrypted: null,
    options: {},
    attackMode: false,
    updatedAt: null,
  };
}

/** Pure: stored row + env → the effective settings. */
export function buildResolvedSettings(
  stored: InstanceCaptchaSettings,
  env: CaptchaEnvOverrides,
  loaded = true
): ResolvedCaptchaSettings {
  let secretKey: string | null;
  let secretState: CaptchaSecretState;
  if (env.secretKey) {
    secretKey = env.secretKey;
    secretState = 'ok';
  } else if (stored.secretEncrypted) {
    secretKey = decryptCaptchaSecret(stored.secretEncrypted);
    secretState = secretKey ? 'ok' : 'undecryptable';
  } else {
    secretKey = null;
    secretState = 'unset';
  }
  return {
    provider: env.provider ?? stored.provider,
    surfaces: parseCaptchaSurfaces(stored.surfaces),
    siteKey: env.siteKey ?? stored.siteKey ?? null,
    secretKey,
    secretState,
    secretHint: captchaSecretHint(secretKey),
    options: fillCaptchaOptions(stored.options),
    attackModeManual: stored.attackMode,
    locked: { provider: env.provider !== null, siteKey: env.siteKey !== null, secretKey: env.secretKey !== null },
    env,
    stored,
    loaded,
  };
}

async function loadSettings(holder: CacheHolder): Promise<ResolvedCaptchaSettings> {
  const env = readCaptchaEnvOverrides();
  try {
    return buildResolvedSettings(await getInstanceCaptchaSettings(getDb()), env);
  } catch (error) {
    // One line a minute at most: a database outage must not flood the log.
    const now = Date.now();
    if (!holder.lastErrorLogAt || now - holder.lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
      holder.lastErrorLogAt = now;
      console.error('[captcha] settings could not be read; using the defaults', JSON.stringify((error as Error).message));
    }
    return buildResolvedSettings(defaultStored(), env, false);
  }
}

/**
 * The effective settings, from the per-process cache when fresh. `fresh`
 * bypasses (and refills) the cache — the admin API reads with it. A failed
 * read answers the protective defaults and is cached for a few seconds.
 */
export async function resolveCaptchaSettings(options: { fresh?: boolean } = {}): Promise<ResolvedCaptchaSettings> {
  const holder = cacheSlot();
  const now = Date.now();
  if (!options.fresh && holder.slot && holder.slot.expiresAt > now) return holder.slot.value;
  if (!options.fresh && holder.pending) return holder.pending;
  const generation = holder.generation;
  const pending = loadSettings(holder).then((value) => {
    // A save that landed while this read was running wins: its
    // invalidation bumped the generation, so this (older) value is dropped.
    if (holder.generation === generation) {
      holder.slot = { value, expiresAt: Date.now() + (value.loaded ? CACHE_TTL_MS : FAILURE_TTL_MS) };
      if (value.loaded) holder.lastGood = value;
    }
    return value;
  });
  holder.pending = pending;
  try {
    return await pending;
  } finally {
    if (holder.pending === pending) holder.pending = undefined;
  }
}

/**
 * The last settings this process actually read (any age), and whether the
 * cache is still fresh — without I/O. The CSP middleware serves `lastGood`
 * at once and refreshes in the background when it is not fresh.
 */
export function captchaSettingsSnapshot(): { lastGood: ResolvedCaptchaSettings | null; fresh: boolean } {
  const holder = cacheSlot();
  return { lastGood: holder.lastGood ?? null, fresh: Boolean(holder.slot && holder.slot.expiresAt > Date.now()) };
}

/** Forget the cached settings (after a save). Reads already running cannot put old values back. */
export function invalidateCaptchaSettingsCache(): void {
  const holder = cacheSlot();
  holder.generation += 1;
  holder.slot = undefined;
  holder.pending = undefined;
  holder.lastGood = undefined;
}

/**
 * Is the configured external provider usable at all — both keys present and
 * the secret decryptable? When it is not, the provider is "misconfigured"
 * (§5): the app serves and accepts ALTCHA instead, and Doctor reports it.
 */
export function externalProviderConfigured(settings: ResolvedCaptchaSettings): boolean {
  return isExternalProvider(settings.provider) && Boolean(settings.siteKey) && settings.secretState === 'ok' && Boolean(settings.secretKey);
}

export { DEFAULT_CAPTCHA_OPTIONS, DEFAULT_CAPTCHA_SURFACES };
