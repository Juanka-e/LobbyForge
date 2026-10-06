/**
 * The admin side of bot protection (docs/CAPTCHA.md §6.1): the GET view,
 * the PUT update rules and the configuration test. The routes under
 * `app/api/admin/captcha` are thin wrappers around these.
 *
 * The secret never leaves the server: the view carries `secretSet` and
 * `secretHint` ("…abcd") only, and the audit entry carries field names only.
 */
import { z } from 'zod';
import { setInstanceCaptchaSettings, type SetInstanceCaptchaSettingsInput } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { getBreakerState, resetBreaker } from './breaker';
import { isTestSecretKey, probeSiteverify } from './providers';
import { encryptCaptchaSecret } from './secret';
import { invalidateCaptchaSettingsCache, resolveCaptchaSettings, type ResolvedCaptchaSettings } from './settings';
import { attackModeAutoUntil } from './signals';
import {
  CAPTCHA_PROVIDERS,
  CaptchaOptionsSchema,
  CaptchaSurfacesSchema,
  fillCaptchaOptions,
  isExternalProvider,
  type CaptchaOptions,
  type CaptchaProvider,
  type CaptchaSurfaces,
} from './types';

export interface AdminCaptchaView {
  provider: CaptchaProvider;
  surfaces: CaptchaSurfaces;
  siteKey: string | null;
  secretSet: boolean;
  secretHint: string | null;
  options: CaptchaOptions;
  attackMode: { manual: boolean; autoUntil: string | null };
  locked: { provider: boolean; siteKey: boolean; secretKey: boolean };
  breaker: { open: boolean; until: string | null };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export async function buildAdminCaptchaView(settings: ResolvedCaptchaSettings): Promise<AdminCaptchaView> {
  const breaker = isExternalProvider(settings.provider) ? await getBreakerState(settings.provider) : null;
  return {
    provider: settings.provider,
    surfaces: settings.surfaces,
    siteKey: settings.siteKey,
    secretSet: settings.secretState !== 'unset',
    secretHint: settings.secretHint,
    options: settings.options,
    attackMode: { manual: settings.attackModeManual, autoUntil: iso(await attackModeAutoUntil()) },
    locked: settings.locked,
    breaker: { open: breaker?.open ?? false, until: iso(breaker?.until ?? null) },
  };
}

/** '' (an empty form field) reads as "not given". */
const blankToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

export const AdminCaptchaUpdateSchema = z
  .object({
    provider: z.enum(CAPTCHA_PROVIDERS),
    surfaces: CaptchaSurfacesSchema,
    // null clears the stored site key; '' is treated as null.
    siteKey: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
      z.string().trim().min(1).max(256).nullable().optional()
    ),
    // A string sets a new secret, null clears it, omitted (or '') keeps it.
    secretKey: z.preprocess(blankToUndefined, z.string().trim().min(1).max(512).nullable().optional()),
    options: CaptchaOptionsSchema,
    attackMode: z.boolean(),
  })
  .strict();

export type AdminCaptchaUpdate = z.infer<typeof AdminCaptchaUpdateSchema>;

export type AdminCaptchaUpdateResult =
  | { ok: true; view: AdminCaptchaView; changedFields: string[] }
  | { ok: false; status: 400 | 409 | 503; body: Record<string, unknown> };

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Apply a PUT: environment-locked fields refuse a different value (409),
 * an external provider needs both keys (400 keys_required), only changed
 * columns are written, and the caches are refreshed. Returns the field
 * names that changed (for the audit entry) and the new view.
 */
export async function applyAdminCaptchaUpdate(update: AdminCaptchaUpdate): Promise<AdminCaptchaUpdateResult> {
  const current = await resolveCaptchaSettings({ fresh: true });
  // Never save against the defaults that stand in for an unreadable row:
  // that would silently reset what is really stored.
  if (!current.loaded) return { ok: false, status: 503, body: { error: 'settings_unavailable' } };
  const stored = current.stored;

  if (current.locked.provider && update.provider !== current.provider) {
    return { ok: false, status: 409, body: { error: 'locked_by_env', field: 'provider' } };
  }
  if (current.locked.siteKey && update.siteKey !== undefined && (update.siteKey ?? null) !== current.siteKey) {
    return { ok: false, status: 409, body: { error: 'locked_by_env', field: 'siteKey' } };
  }
  if (current.locked.secretKey && update.secretKey !== undefined) {
    return { ok: false, status: 409, body: { error: 'locked_by_env', field: 'secretKey' } };
  }

  const provider = current.locked.provider ? current.provider : update.provider;
  const siteKey = current.locked.siteKey ? current.siteKey : update.siteKey !== undefined ? update.siteKey : stored.siteKey;
  const secretPresent = current.locked.secretKey
    ? true
    : update.secretKey !== undefined
      ? update.secretKey !== null
      : Boolean(stored.secretEncrypted);
  if (isExternalProvider(provider) && (!siteKey || !secretPresent)) {
    return { ok: false, status: 400, body: { error: 'keys_required' } };
  }

  const write: SetInstanceCaptchaSettingsInput = {};
  const changed: string[] = [];
  if (!current.locked.provider && update.provider !== stored.provider) {
    write.provider = update.provider;
    changed.push('provider');
  }
  // A client that predates a surface (password_reset) leaves it as stored.
  const surfaces: CaptchaSurfaces = { ...current.surfaces, ...update.surfaces } as CaptchaSurfaces;
  if (!sameJson(surfaces, current.surfaces)) changed.push('surfaces');
  write.surfaces = { ...surfaces };
  if (!current.locked.siteKey && update.siteKey !== undefined && (update.siteKey ?? null) !== stored.siteKey) {
    write.siteKey = update.siteKey ?? null;
    changed.push('siteKey');
  }
  if (!current.locked.secretKey && update.secretKey !== undefined) {
    if (update.secretKey === null) {
      if (stored.secretEncrypted) {
        write.secretEncrypted = null;
        changed.push('secretKey');
      }
    } else if (update.secretKey !== current.secretKey || current.secretState !== 'ok') {
      write.secretEncrypted = encryptCaptchaSecret(update.secretKey);
      changed.push('secretKey');
    }
  }
  const options = Object.fromEntries(Object.entries(update.options).filter(([, value]) => value !== undefined));
  // Compared with the defaults filled in: making a default explicit is no change.
  if (!sameJson(fillCaptchaOptions(options), current.options)) changed.push('options');
  write.options = options;
  if (update.attackMode !== stored.attackMode) {
    write.attackMode = update.attackMode;
    changed.push('attackMode');
  }

  await setInstanceCaptchaSettings(getDb(), write);
  invalidateCaptchaSettingsCache();
  if (changed.some((field) => field === 'provider' || field === 'siteKey' || field === 'secretKey')) {
    // New keys or a new provider deserve a fresh start (a bad_secret breaker
    // would otherwise keep ALTCHA in place for up to 5 minutes).
    await resetBreaker('turnstile');
    await resetBreaker('recaptcha');
  }
  const view = await buildAdminCaptchaView(await resolveCaptchaSettings({ fresh: true }));
  return { ok: true, view, changedFields: changed };
}

export const AdminCaptchaTestSchema = z
  .object({
    provider: z.enum(CAPTCHA_PROVIDERS).optional(),
    siteKey: z.preprocess(blankToUndefined, z.string().trim().min(1).max(256).optional()),
    secretKey: z.preprocess(blankToUndefined, z.string().trim().min(1).max(512).optional()),
  })
  .strict();

/**
 * `detail` of a test result — a code the admin card translates
 * (docs/CAPTCHA.md §6.1), never a sentence.
 */
export type AdminCaptchaTestDetail =
  | 'secret_undecryptable'
  | 'missing_site_key'
  | 'missing_secret_key'
  | 'missing_both'
  | 'test_keys'
  | 'recaptcha_reachability_only';

export type AdminCaptchaTestResult = {
  result: 'ok' | 'bad_secret' | 'unreachable' | 'missing_keys' | 'not_applicable';
  detail?: AdminCaptchaTestDetail;
};

/**
 * "Test configuration": a siteverify call with a dummy token. Values left
 * out fall back to the saved ones. Nothing is stored and no breaker moves.
 */
export async function testCaptchaConfiguration(input: z.infer<typeof AdminCaptchaTestSchema>): Promise<AdminCaptchaTestResult> {
  const current = await resolveCaptchaSettings({ fresh: true });
  const provider = input.provider ?? current.provider;
  if (!isExternalProvider(provider)) return { result: 'not_applicable' };
  const siteKey = input.siteKey ?? current.siteKey;
  const secret = input.secretKey ?? current.secretKey;
  if (!siteKey || !secret) {
    const undecryptable = !input.secretKey && current.secretState === 'undecryptable';
    if (siteKey && undecryptable) return { result: 'missing_keys', detail: 'secret_undecryptable' };
    return { result: 'missing_keys', detail: !siteKey && !secret ? 'missing_both' : !siteKey ? 'missing_site_key' : 'missing_secret_key' };
  }
  const result = await probeSiteverify(provider, secret);
  if (result !== 'ok') return { result };
  // The provider's public test keys: every challenge passes.
  if (isTestSecretKey(provider, secret)) return { result: 'ok', detail: 'test_keys' };
  // Google checks a real token before the secret: a dummy call proves reachability only.
  if (provider === 'recaptcha') return { result: 'ok', detail: 'recaptcha_reachability_only' };
  return { result: 'ok' };
}
