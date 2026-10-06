/**
 * Shared e2e helpers for the auth routes behind bot protection
 * (docs/CAPTCHA.md): new guests, sign-up and sign-in, the way a real client
 * does it — with protection ON.
 *
 *   1. read the surface's public config (`GET /api/auth/captcha?surface=…`):
 *      is a challenge required now, which provider, and a fresh `formToken`
 *      (fetched again for every attempt — never reused);
 *   2. ALTCHA: fetch a challenge (`GET /api/auth/captcha/challenge`) and
 *      solve it in Node with `altcha-lib` — every parameter (algorithm,
 *      cost, key prefix, signature) comes from the server's challenge;
 *      Turnstile: Cloudflare's dummy token, which only the always-pass TEST
 *      secret accepts (the helpers cannot pass a real Turnstile or any
 *      reCAPTCHA);
 *   3. wait until the form is at least 2 s old (the minimum fill time);
 *   4. POST with `captchaToken`, `captchaProvider` and `formToken`.
 *
 * Rate limits: without a trusted proxy every test client is the same
 * address ("unknown"). Sign-in (10) and sign-up (5 per 15 minutes) stay
 * per-address buckets, so the whole suite shares one of each; new guests
 * get an instance-wide backstop (200 per hour) that several full runs in
 * an hour can still use up. On a 429 from those routes the helpers clear
 * that bucket in the stack's Redis (the documented `*rate-limit*` reset,
 * narrowed to the one route) and try again; without Docker access they wait
 * out a short Retry-After instead. The per-account sign-in lock is never
 * touched. (The challenge and config backstops — 600 and 1200 per minute —
 * are out of the suite's reach, so they get no relief.)
 *
 *   LF_E2E_REDIS_CONTAINER  Redis container of the stack under test
 *                           (default: lobbyforge-e2e-redis for ports
 *                           19620/19630, lobbyforge-redis otherwise;
 *                           "none" turns the reset off)
 *   LF_E2E_REDIS_PASSWORD   its password (default lobbyforge_dev)
 */
import { execFileSync } from 'node:child_process';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';

export type FormCaptchaSurface = 'register' | 'invite_register' | 'guest';
export type CaptchaSurface = FormCaptchaSurface | 'login' | 'password_reset';
export type CaptchaProvider = 'none' | 'altcha' | 'turnstile' | 'recaptcha';

export interface CaptchaFields {
  captchaToken?: string;
  captchaProvider?: Exclude<CaptchaProvider, 'none'>;
  formToken?: string;
}

/** `GET /api/auth/captcha?surface=…` (docs/CAPTCHA.md §4.1). */
export interface PublicCaptchaConfig {
  surface: CaptchaSurface;
  required: boolean;
  mode: string;
  provider: CaptchaProvider;
  siteKey: string | null;
  options: { turnstileAppearance?: string; recaptchaVersion?: string };
  formToken: string | null;
}

export type Headers = Record<string, string>;

export interface AuthRequest {
  data?: Record<string, unknown>;
  headers?: Headers;
}

/** Cloudflare's dummy response token — accepted only by the always-pass TEST secret (1x…AA). */
export const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
/** The server refuses a form sent < 2 s after its formToken was issued; keep a margin. */
export const FORM_MIN_FILL_MS = 2_250;

// New guests: `captcha-guest-new` (the backstop's key for unknown addresses) and the route's own 30/min.
const GUEST_BUCKETS = ['captcha-guest-new', 'auth-guest-post'];
const REGISTER_BUCKETS = ['auth-local-register'];
const LOGIN_BUCKETS = ['auth-local-login'];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ── Rate-limit relief ───────────────────────────────────────────────────

function redisTarget(): { container: string; password: string } | null {
  const configured = process.env.LF_E2E_REDIS_CONTAINER;
  if (configured === 'none') return null;
  let container = configured;
  if (!container) {
    const port = (() => {
      try {
        return new URL(process.env.LF_E2E_BASE_URL ?? '').port;
      } catch {
        return '';
      }
    })();
    container = port === '19620' || port === '19630' ? 'lobbyforge-e2e-redis' : 'lobbyforge-redis';
  }
  return { container, password: process.env.LF_E2E_REDIS_PASSWORD ?? 'lobbyforge_dev' };
}

const CLEAR_SCRIPT =
  "local n = 0 for _, pattern in ipairs(ARGV) do for _, key in ipairs(redis.call('KEYS', pattern)) do n = n + redis.call('DEL', key) end end return n";

function deleteKeys(patterns: readonly string[]): boolean {
  const target = redisTarget();
  if (!target || patterns.length === 0) return false;
  try {
    execFileSync(
      'docker',
      ['exec', target.container, 'redis-cli', '-a', target.password, '--no-auth-warning', 'EVAL', CLEAR_SCRIPT, '0', ...patterns],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * A fresh rate-limit window for a spec that drives several users through
 * the same routes (the documented `*rate-limit*` reset): every context here
 * is one client address, so the previous spec's players count against this
 * one's — e.g. `activity-action`, 30 per minute. Also clears the sign-in
 * counters and attack mode. False when Redis cannot be reached.
 */
export function resetRateLimits(): boolean {
  return deleteKeys(['*rate-limit*']);
}

/**
 * Clear the named rate-limit buckets (`lf:<env>:rate-limit:<identifier>:*`)
 * in the stack's Redis. False when that is not possible (no Docker, no
 * container) — the caller then waits instead.
 */
export function clearRateLimitBuckets(identifiers: readonly string[]): boolean {
  if (identifiers.length === 0) return false;
  return deleteKeys(identifiers.map((id) => `*rate-limit:${id}:*`));
}

/** After a 429: clear the buckets, or wait out a short Retry-After. True when a retry makes sense. */
async function relieve(res: APIResponse, identifiers: readonly string[]): Promise<boolean> {
  if (clearRateLimitBuckets(identifiers)) {
    console.info(`[e2e] 429 — cleared the shared rate-limit bucket(s) ${identifiers.join(', ')}`);
    return true;
  }
  const wait = Number(res.headers()['retry-after'] ?? '0');
  if (!(wait > 0 && wait <= 75)) return false;
  console.info(`[e2e] 429 on ${identifiers.join(', ')} — waiting ${wait + 1}s`);
  await sleep((wait + 1) * 1000);
  return true;
}

/** The `error` code of a 400 JSON answer, or null. */
export async function refusalOf(res: APIResponse): Promise<string | null> {
  if (res.status() !== 400) return null;
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

// ── The challenge ───────────────────────────────────────────────────────

export async function getCaptchaConfig(
  api: APIRequestContext,
  surface: CaptchaSurface,
  headers?: Headers
): Promise<PublicCaptchaConfig> {
  const res = await api.get(`/api/auth/captcha?surface=${surface}`, { headers });
  if (res.status() !== 200) throw new Error(`captcha config for ${surface}: HTTP ${res.status()} ${await res.text()}`);
  return (await res.json()) as PublicCaptchaConfig;
}

/** A fresh ALTCHA challenge for `surface`, as the server signed it. */
export async function getAltchaChallenge(api: APIRequestContext, surface: CaptchaSurface, headers?: Headers): Promise<Challenge> {
  const res = await api.get(`/api/auth/captcha/challenge?surface=${surface}`, { headers });
  if (res.status() !== 200) throw new Error(`ALTCHA challenge for ${surface}: HTTP ${res.status()} ${await res.text()}`);
  return (await res.json()) as Challenge;
}

/** Solve a challenge in Node; returns the widget's payload (base64 JSON) to send as `captchaToken`. */
export async function solveAltcha(challenge: Challenge): Promise<string> {
  const solution = await solveChallenge({ challenge, deriveKey, timeout: 60_000 });
  if (!solution) throw new Error('ALTCHA challenge could not be solved within 60 s');
  return Buffer.from(JSON.stringify({ challenge, solution })).toString('base64');
}

/** Fetch and solve one ALTCHA challenge for `surface`. */
export async function solveAltchaToken(api: APIRequestContext, surface: CaptchaSurface, headers?: Headers): Promise<string> {
  return solveAltcha(await getAltchaChallenge(api, surface, headers));
}

/**
 * Everything a protected request needs for `surface`, from a FRESH config:
 * the solved token and the formToken, returned once the form is old enough
 * to send. Empty when the surface needs nothing now (unless `force`: the
 * server already answered `captcha_required`, e.g. adaptive sign-in).
 */
export async function captchaFields(
  api: APIRequestContext,
  surface: CaptchaSurface,
  { headers, force = false }: { headers?: Headers; force?: boolean } = {}
): Promise<CaptchaFields> {
  const config = await getCaptchaConfig(api, surface, headers);
  const receivedAt = Date.now();
  if (config.provider === 'none' || !(config.required || force)) return {};
  const fields: CaptchaFields = {};
  if (config.formToken) fields.formToken = config.formToken;
  switch (config.provider) {
    case 'altcha':
      fields.captchaToken = await solveAltchaToken(api, surface, headers);
      fields.captchaProvider = 'altcha';
      break;
    case 'turnstile':
      fields.captchaToken = TURNSTILE_TEST_TOKEN;
      fields.captchaProvider = 'turnstile';
      break;
    case 'recaptcha':
      throw new Error('The e2e helpers cannot pass reCAPTCHA — switch the instance back to ALTCHA (or Turnstile test keys).');
  }
  if (fields.formToken) await sleep(receivedAt + FORM_MIN_FILL_MS - Date.now());
  return fields;
}

// ── The routes ──────────────────────────────────────────────────────────

/**
 * `POST /api/auth/guest` through the challenge. Returns the route's answer
 * (200 with `{ guest }` on success). A context that already holds a valid
 * guest cookie just refreshes it (the server ignores the token then).
 */
export async function createGuest(api: APIRequestContext, { data = {}, headers }: AuthRequest = {}): Promise<APIResponse> {
  let res: APIResponse | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fields = await captchaFields(api, 'guest', { headers });
    res = await api.post('/api/auth/guest', { headers, data: { ...data, ...fields } });
    if (res.status() === 429) {
      if (await relieve(res, GUEST_BUCKETS)) continue;
      return res;
    }
    // The settings changed between the config and the POST (another spec
    // switched provider), or an external provider went down: start over.
    const refusal = await refusalOf(res);
    if (refusal === 'captcha_required' || refusal === 'captcha_unavailable') continue;
    return res;
  }
  return res!;
}

/**
 * `POST /api/auth/register` through the challenge (201 on success). With an
 * invite code the server picks `invite_register` or `register` by its own
 * rules; when the token was solved for the other one, the helper solves
 * for that and sends again.
 */
export async function registerAccount(api: APIRequestContext, { data = {}, headers }: AuthRequest = {}): Promise<APIResponse> {
  const surfaces: FormCaptchaSurface[] = data.inviteCode ? ['invite_register', 'register'] : ['register'];
  let res: APIResponse | null = null;
  for (let attempt = 0, index = 0; attempt < 4 && index < surfaces.length; attempt += 1) {
    const fields = await captchaFields(api, surfaces[index]!, { headers });
    res = await api.post('/api/auth/register', { headers, data: { ...data, ...fields } });
    if (res.status() === 429) {
      if (await relieve(res, REGISTER_BUCKETS)) continue;
      return res;
    }
    const refusal = await refusalOf(res);
    if (refusal === 'captcha_unavailable') continue;
    if ((refusal === 'captcha_required' || refusal === 'captcha_invalid' || refusal === 'form_rejected') && index + 1 < surfaces.length) {
      index += 1;
      continue;
    }
    return res;
  }
  return res!;
}

/**
 * `POST /api/auth/login`. Sign-in is adaptive: no challenge until the
 * server answers `captcha_required` (failures on the account, attack mode,
 * or `always`) — then solve the `login` challenge and send again.
 */
export async function signIn(api: APIRequestContext, { data = {}, headers }: AuthRequest = {}): Promise<APIResponse> {
  let res: APIResponse | null = null;
  let fields: CaptchaFields = {};
  let relieved = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    res = await api.post('/api/auth/login', { headers, data: { ...data, ...fields } });
    if (res.status() === 429) {
      // The per-account lock answers exactly like the address limiter (no
      // account enumeration): relieve the shared address bucket once; a
      // second 429 is the account's own lock and is the answer.
      if (relieved || !(await relieve(res, LOGIN_BUCKETS))) return res;
      relieved = true;
      fields = {}; // a solved challenge is single-use
      continue;
    }
    const refusal = await refusalOf(res);
    if (refusal === 'captcha_required' || refusal === 'captcha_unavailable') {
      fields = await captchaFields(api, 'login', { headers, force: true });
      continue;
    }
    return res;
  }
  return res!;
}

/**
 * `POST /api/auth/password/forgot` through the `password_reset` challenge
 * (docs/EMAIL.md §4.3). Always 202 `{ sent: true }` when accepted, for a
 * known address or not; 503 `mail_unavailable` when the instance has no mail.
 */
export async function requestPasswordReset(api: APIRequestContext, email: string, { headers }: { headers?: Headers } = {}): Promise<APIResponse> {
  let res: APIResponse | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fields = await captchaFields(api, 'password_reset', { headers });
    res = await api.post('/api/auth/password/forgot', { headers, data: { email, ...fields } });
    const refusal = await refusalOf(res);
    if (refusal === 'captcha_required' || refusal === 'captcha_unavailable') continue;
    return res;
  }
  return res!;
}
