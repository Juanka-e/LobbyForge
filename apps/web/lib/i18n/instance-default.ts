/**
 * The instance's default language — the one place that decides it.
 * Server only (reads the database and the disk).
 *
 *   the admin's choice (instance_settings.default_locale, set at /setup or
 *   in Admin → Overview) → LOBBYFORGE_DEFAULT_LOCALE → English
 *
 * Each step counts only when it names an installed language, so a code
 * whose folder was since removed (or a typo in the env) is skipped rather
 * than served. The default is a fallback, not an override: it is used
 * when an account, its browser's cookie and its Accept-Language all say
 * nothing the instance offers — and for text that has no single reader
 * (the built-in bots, an email with no recipient language).
 *
 * The saved value is cached per process for `CACHE_TTL_MS` and replaced at
 * once when this process saves a new one (`rememberInstanceDefaultLocale`);
 * another process sees the change when its cache expires. Two readers:
 *
 *   - `getInstanceDefaultLocale()` — async, refreshes a stale cache first.
 *     Use it wherever you can await.
 *   - `instanceDefaultLocale()` — sync, answers from the cache (refreshing
 *     it in the background when stale). For sync code paths such as the
 *     bots' default texts. Every page render and every
 *     `localeFromRequest` call warms the cache, so it is right in
 *     practice; right after a restart, before any request, it answers
 *     from the env.
 */
import { getInstanceDefaultLocaleSetting } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { getDiscovery } from './catalogue';
import { SOURCE_LOCALE, installedLocale, type LocaleInfo } from './core';

export const DEFAULT_LOCALE_ENV = 'LOBBYFORGE_DEFAULT_LOCALE';
export const CACHE_TTL_MS = 30_000;

/** Which step decided: the admin's saved choice, the env, or neither (English). */
export type DefaultLocaleSource = 'saved' | 'env' | 'fallback';

export interface ResolvedInstanceDefault {
  code: string;
  source: DefaultLocaleSource;
}

/** The precedence itself, pure — the tests pin it here. */
export function resolveInstanceDefault(input: {
  saved: string | null | undefined;
  env: string | null | undefined;
  available: readonly string[];
}): ResolvedInstanceDefault {
  const saved = installedLocale(input.saved, input.available);
  if (saved) return { code: saved, source: 'saved' };
  const env = installedLocale(input.env, input.available);
  if (env) return { code: env, source: 'env' };
  return { code: installedLocale(SOURCE_LOCALE, input.available) ?? SOURCE_LOCALE, source: 'fallback' };
}

interface CacheState {
  /** The raw saved value (unvalidated), or null when none is saved. */
  saved: string | null;
  /** When `saved` was last read or written; 0 = never. */
  loadedAt: number;
  inflight: Promise<void> | null;
  /** Bumped by every save, so a read that started before it cannot overwrite it. */
  generation: number;
  warnedEnv: string | null;
  warnedRead: boolean;
}

// On globalThis, like the database client (lib/db.ts): Next can load this
// module more than once in one process (route handlers and server
// components are bundled separately), and a save from the admin route
// must reach the page renders.
const GLOBAL_KEY = '__lobbyforge_instance_default_locale__';

function state(): CacheState {
  const g = globalThis as unknown as Record<string, CacheState | undefined>;
  let current = g[GLOBAL_KEY];
  if (!current) {
    current = { saved: null, loadedAt: 0, inflight: null, generation: 0, warnedEnv: null, warnedRead: false };
    g[GLOBAL_KEY] = current;
  }
  return current;
}

function installedCodes(): string[] {
  return getDiscovery().locales.map((locale) => locale.code);
}

function isStale(s: CacheState): boolean {
  return s.loadedAt === 0 || Date.now() - s.loadedAt >= CACHE_TTL_MS;
}

function refresh(): Promise<void> {
  const s = state();
  if (s.inflight) return s.inflight;
  const generation = s.generation;
  s.inflight = (async () => {
    try {
      const saved = await getInstanceDefaultLocaleSetting(getDb());
      if (s.generation === generation) s.saved = saved;
    } catch (error) {
      // Keep the last value we had (or none): the env and English still
      // answer. Logged once — a database outage is reported elsewhere.
      if (!s.warnedRead && process.env.NODE_ENV !== 'test') {
        s.warnedRead = true;
        console.warn('[i18n] could not read the instance default language:', (error as Error).message);
      }
    } finally {
      s.loadedAt = Date.now();
      s.inflight = null;
    }
  })();
  return s.inflight;
}

function resolveFromCache(available: readonly string[]): ResolvedInstanceDefault {
  const s = state();
  const env = process.env[DEFAULT_LOCALE_ENV]?.trim() || null;
  const resolved = resolveInstanceDefault({ saved: s.saved, env, available });
  if (env && !installedLocale(env, available) && s.warnedEnv !== env) {
    s.warnedEnv = env;
    console.warn(`[i18n] ${DEFAULT_LOCALE_ENV}="${env}" is not an installed language; ignoring it`);
  }
  return resolved;
}

/** The default language, from the cache — refreshed in the background when stale. */
export function instanceDefaultLocale(available: readonly string[] = installedCodes()): string {
  if (isStale(state())) void refresh();
  return resolveFromCache(available).code;
}

/** The default language, reading the database first when the cache is stale. */
export async function getInstanceDefaultLocale(available: readonly string[] = installedCodes()): Promise<string> {
  if (isStale(state())) await refresh();
  return resolveFromCache(available).code;
}

export interface InstanceDefaultLocaleInfo extends ResolvedInstanceDefault {
  /** What the admin saved, as stored (null = nothing saved). */
  saved: string | null;
  /** Whether `saved` is still an installed language. */
  savedInstalled: boolean;
  /** LOBBYFORGE_DEFAULT_LOCALE as set (null = unset). */
  env: string | null;
  /** Whether `env` names an installed language. */
  envInstalled: boolean;
}

/** Everything the admin page shows: the effective default, which step decided, and both inputs. */
export async function getInstanceDefaultLocaleInfo(
  options: { fresh?: boolean; available?: readonly string[] } = {}
): Promise<InstanceDefaultLocaleInfo> {
  const available = options.available ?? installedCodes();
  if (options.fresh || isStale(state())) await refresh();
  const resolved = resolveFromCache(available);
  const saved = state().saved;
  const env = process.env[DEFAULT_LOCALE_ENV]?.trim() || null;
  return {
    ...resolved,
    saved,
    savedInstalled: installedLocale(saved, available) !== null,
    env,
    envInstalled: installedLocale(env, available) !== null,
  };
}

/** What Admin → Overview → Default language shows and what its API answers. */
export interface DefaultLocaleAdminView extends InstanceDefaultLocaleInfo {
  /** Every installed language, in its own name, with its status. */
  locales: Pick<LocaleInfo, 'code' | 'name' | 'englishName' | 'status'>[];
}

export async function getDefaultLocaleAdminView(options: { fresh?: boolean } = {}): Promise<DefaultLocaleAdminView> {
  const { locales } = getDiscovery();
  const info = await getInstanceDefaultLocaleInfo({ fresh: options.fresh, available: locales.map((l) => l.code) });
  return {
    ...info,
    locales: locales.map(({ code, name, englishName, status }) => ({ code, name, englishName, status })),
  };
}

/** After this process saved a new default (or cleared it): use it at once. */
export function rememberInstanceDefaultLocale(saved: string | null): void {
  const s = state();
  s.generation += 1;
  s.saved = saved;
  s.loadedAt = Date.now();
}

/** Tests only: forget the cache so the next read goes to the database. */
export function __resetInstanceDefaultLocaleForTests(): void {
  const g = globalThis as unknown as Record<string, CacheState | undefined>;
  delete g[GLOBAL_KEY];
}
