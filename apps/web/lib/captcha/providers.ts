/**
 * The external providers' server-side checks (docs/CAPTCHA.md §5):
 *
 * - Cloudflare Turnstile: POST https://challenges.cloudflare.com/turnstile/v0/siteverify
 *   (secret, response, remoteip, idempotency_key — the same key on the retry,
 *   so Cloudflare treats it as one validation). Checks `success`, that
 *   `hostname` is the app's host and that `action` is the surface.
 * - Google reCAPTCHA: POST https://www.google.com/recaptcha/api/siteverify
 *   (secret, response, remoteip). Checks `success` and `hostname`; for v3
 *   also `action` = surface and `score >= recaptchaMinScore`. Keys created
 *   in (or migrated to) Google Cloud keep answering this endpoint.
 *
 * Network: 3 s per attempt (DNS included), one retry after a network error or a 5xx, over
 * the shared IP-pinned HTTPS transport (`lib/ip-pinned-https.ts` — DNS is
 * resolved and checked once, the connection goes to exactly those
 * addresses, redirects are never followed). Tokens and secrets are never
 * logged.
 *
 * The providers' published test keys answer for a fixed hostname
 * (example.com / testkey.google.com) without an action; with a test secret
 * those two checks are skipped, so the documented e2e keys work. Doctor
 * flags test keys in production.
 */
import { randomUUID } from 'node:crypto';
import { fetchIpPinned, resolvePublicAddresses } from '@/lib/ip-pinned-https';
import type { CaptchaSurface, ExternalCaptchaProvider, RecaptchaVersion } from './types';

export const SITEVERIFY_URLS: Record<ExternalCaptchaProvider, string> = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  recaptcha: 'https://www.google.com/recaptcha/api/siteverify',
};

export const SITEVERIFY_TIMEOUT_MS = 3_000;

/** Cloudflare's and Google's published test secrets (always pass / always fail / spent). */
export const TEST_SECRET_KEYS: Record<ExternalCaptchaProvider, readonly string[]> = {
  turnstile: [
    '1x0000000000000000000000000000000AA',
    '2x0000000000000000000000000000000AA',
    '3x0000000000000000000000000000000AA',
  ],
  recaptcha: ['6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe'],
};

/** Their published test site keys. */
export const TEST_SITE_KEYS: Record<ExternalCaptchaProvider, readonly string[]> = {
  turnstile: [
    '1x00000000000000000000AA',
    '2x00000000000000000000AB',
    '1x00000000000000000000BB',
    '2x00000000000000000000BB',
    '3x00000000000000000000FF',
  ],
  recaptcha: ['6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI'],
};

export function isTestSecretKey(provider: ExternalCaptchaProvider, secret: string | null | undefined): boolean {
  return Boolean(secret) && TEST_SECRET_KEYS[provider].includes(secret!);
}

export function isTestSiteKey(provider: ExternalCaptchaProvider, siteKey: string | null | undefined): boolean {
  return Boolean(siteKey) && TEST_SITE_KEYS[provider].includes(siteKey!);
}

/**
 * What a siteverify call came to:
 * - `ok` — a valid token for this host and surface;
 * - `invalid` / `expired` / `duplicate` — a bad token (the user retries);
 * - `bad_secret` — the provider refused the secret (misconfigured);
 * - `unavailable` — no usable answer (network, timeout, 5xx, garbage),
 *   after the retry.
 */
export type ProviderOutcome = 'ok' | 'invalid' | 'expired' | 'duplicate' | 'bad_secret' | 'unavailable';

interface SiteverifyAnswer {
  status: number;
  body: Record<string, unknown> | null;
}

export type SiteverifyTransport = (url: string, form: URLSearchParams) => Promise<SiteverifyAnswer>;

/** Settles like `promise`, or rejects once `signal` aborts — whichever comes first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Request exceeded the siteverify deadline'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Request exceeded the siteverify deadline'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * The default transport: one IP-pinned HTTPS POST, form-encoded. The DNS
 * lookup and the request share ONE 3 s deadline per attempt.
 */
export const pinnedSiteverifyTransport: SiteverifyTransport = async (url, form) => {
  const { hostname } = new URL(url);
  const deadline = AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS);
  const addresses = await untilAborted(resolvePublicAddresses(hostname), deadline);
  const response = await fetchIpPinned(url, hostname, addresses, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    signal: deadline,
    timeoutMs: SITEVERIFY_TIMEOUT_MS,
    headersTimeoutMs: SITEVERIFY_TIMEOUT_MS,
    totalTimeoutMs: SITEVERIFY_TIMEOUT_MS,
    maxStreamBytes: 64 * 1024,
  });
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(response.body.toString('utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: response.status, body };
};

const transportHolder: { current: SiteverifyTransport } = { current: pinnedSiteverifyTransport };

/** Test-only: swap the network (null restores the pinned HTTPS transport). */
export function setSiteverifyTransportForTests(transport: SiteverifyTransport | null): void {
  transportHolder.current = transport ?? pinnedSiteverifyTransport;
}

/** One POST and, after a network error or a 5xx, exactly one retry. Null when neither gave a JSON answer. */
async function siteverify(provider: ExternalCaptchaProvider, form: URLSearchParams): Promise<SiteverifyAnswer | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const answer = await transportHolder.current(SITEVERIFY_URLS[provider], form);
      if (answer.status >= 500 || !answer.body) continue;
      return answer;
    } catch (error) {
      // Never the token or the secret — only which provider and what failed.
      console.warn(`[captcha] ${provider} siteverify attempt ${attempt + 1} failed: ${JSON.stringify((error as Error).message)}`);
    }
  }
  return null;
}

function errorCodes(body: Record<string, unknown>): string[] {
  const codes = body['error-codes'];
  return Array.isArray(codes) ? codes.filter((c): c is string => typeof c === 'string') : [];
}

function failureOutcome(codes: string[]): ProviderOutcome {
  if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) return 'bad_secret';
  if (codes.includes('timeout-or-duplicate')) return 'duplicate';
  if (codes.includes('internal-error')) return 'unavailable';
  return 'invalid';
}

function hostMatches(hostname: unknown, expectedHosts: readonly string[]): boolean {
  return typeof hostname === 'string' && expectedHosts.includes(hostname.toLowerCase());
}

export interface ExternalVerifyInput {
  token: string;
  secret: string;
  surface: CaptchaSurface;
  /** Lower-case hostnames the app answers on (see `expectedAppHosts`). */
  expectedHosts: readonly string[];
  remoteIp?: string | null;
}

export async function verifyTurnstile(input: ExternalVerifyInput): Promise<ProviderOutcome> {
  const form = new URLSearchParams({ secret: input.secret, response: input.token, idempotency_key: randomUUID() });
  if (input.remoteIp) form.set('remoteip', input.remoteIp);
  const answer = await siteverify('turnstile', form);
  if (!answer?.body) return 'unavailable';
  const body = answer.body;
  if (body.success !== true) return failureOutcome(errorCodes(body));
  if (isTestSecretKey('turnstile', input.secret)) return 'ok';
  if (!hostMatches(body.hostname, input.expectedHosts)) return 'invalid';
  if (body.action !== input.surface) return 'invalid';
  return 'ok';
}

export async function verifyRecaptcha(
  input: ExternalVerifyInput & { version: RecaptchaVersion; minScore: number }
): Promise<ProviderOutcome> {
  const form = new URLSearchParams({ secret: input.secret, response: input.token });
  if (input.remoteIp) form.set('remoteip', input.remoteIp);
  const answer = await siteverify('recaptcha', form);
  if (!answer?.body) return 'unavailable';
  const body = answer.body;
  if (body.success !== true) return failureOutcome(errorCodes(body));
  if (isTestSecretKey('recaptcha', input.secret)) return 'ok';
  if (!hostMatches(body.hostname, input.expectedHosts)) return 'invalid';
  if (input.version === 'v3') {
    if (body.action !== input.surface) return 'invalid';
    if (typeof body.score !== 'number' || body.score < input.minScore) return 'invalid';
  }
  return 'ok';
}

/** A dummy token no provider accepts — enough to tell reachable / bad secret apart. */
export const PROBE_TOKEN = 'lobbyforge-reachability-probe';

/**
 * Reachability probe (§5): a siteverify call with a dummy token. A normal
 * "invalid token" answer means reachable (and, for Turnstile, a valid
 * secret). Google checks the token before the secret, so for reCAPTCHA a
 * bad secret only shows up on the first real verification.
 */
export async function probeSiteverify(provider: ExternalCaptchaProvider, secret: string): Promise<'ok' | 'bad_secret' | 'unreachable'> {
  const form = new URLSearchParams({ secret, response: PROBE_TOKEN });
  if (provider === 'turnstile') form.set('idempotency_key', randomUUID());
  const answer = await siteverify(provider, form);
  if (!answer?.body) return 'unreachable';
  if (answer.body.success === true) return 'ok';
  const outcome = failureOutcome(errorCodes(answer.body));
  if (outcome === 'bad_secret') return 'bad_secret';
  if (outcome === 'unavailable') return 'unreachable';
  return 'ok';
}

/**
 * The hostnames a provider may report for this app: the declared public
 * origins (LOBBYFORGE_APP_ORIGIN, NEXT_PUBLIC_BASE_URL) and the host the
 * request came in on — the same set the origin guard accepts.
 */
export function expectedAppHosts(req: Request): string[] {
  const hosts = new Set<string>();
  for (const value of [req.url, process.env.LOBBYFORGE_APP_ORIGIN, process.env.NEXT_PUBLIC_BASE_URL]) {
    if (!value) continue;
    try {
      hosts.add(new URL(value).hostname.toLowerCase());
    } catch {
      // not a URL — skip
    }
  }
  return [...hosts];
}
