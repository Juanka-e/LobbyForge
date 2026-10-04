/**
 * The external-provider breaker (docs/CAPTCHA.md §5).
 *
 * - Opens after 3 consecutive network / 5xx failures of real verifications,
 *   when the cached reachability probe fails, or when the PROBE (a dummy
 *   token only the real secret can get a normal answer for) says the secret
 *   is refused (`bad_secret`: no token could ever pass, so the app falls
 *   back to ALTCHA and Doctor says why). A "bad secret" answer to a REAL
 *   verification never opens it on its own — a token minted with another
 *   key can draw it, so an attacker could pin the instance to the fallback.
 *   It is recorded (`recordBadSecretSeen`) for Doctor, and for Turnstile it
 *   triggers the probe, which confirms.
 * - Stays open for 5 minutes. While it is open the public config serves
 *   `altcha` and ALTCHA tokens are accepted.
 * - State lives in Redis so every process agrees, with an in-process copy
 *   as the fallback when Redis is unavailable.
 * - The probe is a siteverify call with a dummy token, at most once per 60 s
 *   per provider and secret (a Redis `SET NX` elects the process that runs
 *   it), triggered lazily by the public config route. Its last result is
 *   kept for Doctor.
 */
import { createHash } from 'node:crypto';
import {
  captchaKey,
  memoryDel,
  memoryGet,
  memoryIncr,
  memorySet,
  memorySetNx,
  storeDel,
  storeGet,
  storeIncr,
  storeSet,
  storeSetNx,
} from './store';
import { probeSiteverify } from './providers';
import type { ExternalCaptchaProvider } from './types';

export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_OPEN_MS = 5 * 60_000;
export const PROBE_INTERVAL_MS = 60_000;
/** Consecutive failures older than this no longer count towards opening. */
const FAILURE_MEMORY_MS = 10 * 60_000;

export type BreakerReason = 'failures' | 'probe' | 'bad_secret';

export interface BreakerState {
  open: boolean;
  /** When it closes again (ms since the epoch), or null. */
  until: number | null;
  reason: BreakerReason | null;
}

const CLOSED: BreakerState = { open: false, until: null, reason: null };

const stateKey = (provider: ExternalCaptchaProvider) => captchaKey(`breaker:${provider}`);
const failuresKey = (provider: ExternalCaptchaProvider) => captchaKey(`breaker-failures:${provider}`);

function secretTag(secret: string): string {
  return createHash('sha256').update(`lobbyforge:captcha-probe:${secret}`).digest('hex').slice(0, 16);
}

const probeLockKey = (provider: ExternalCaptchaProvider, secret: string) => captchaKey(`probe-lock:${provider}:${secretTag(secret)}`);
const probeResultKey = (provider: ExternalCaptchaProvider, secret: string) => captchaKey(`probe-result:${provider}:${secretTag(secret)}`);

function parseState(raw: string | null, now: number): BreakerState {
  if (!raw) return CLOSED;
  try {
    const value = JSON.parse(raw) as { until?: unknown; reason?: unknown };
    const until = typeof value.until === 'number' ? value.until : 0;
    if (until <= now) return CLOSED;
    const reason = value.reason === 'probe' || value.reason === 'bad_secret' ? value.reason : 'failures';
    return { open: true, until, reason };
  } catch {
    return CLOSED;
  }
}

export async function getBreakerState(provider: ExternalCaptchaProvider, now: number = Date.now()): Promise<BreakerState> {
  try {
    return parseState(await storeGet(stateKey(provider)), now);
  } catch {
    return parseState(memoryGet(stateKey(provider)), now);
  }
}

export async function openBreaker(provider: ExternalCaptchaProvider, reason: BreakerReason, now: number = Date.now()): Promise<void> {
  const value = JSON.stringify({ until: now + BREAKER_OPEN_MS, reason });
  memorySet(stateKey(provider), value, BREAKER_OPEN_MS);
  try {
    await storeSet(stateKey(provider), value, BREAKER_OPEN_MS);
  } catch (error) {
    console.error('[captcha] breaker state could not be shared (kept in memory)', (error as Error).message);
  }
  console.warn(`[captcha] ${provider} breaker open for ${BREAKER_OPEN_MS / 60_000} min (${reason}) — serving ALTCHA`);
}

/** Close it and forget the failures — after the admin saves new provider settings. */
export async function resetBreaker(provider: ExternalCaptchaProvider): Promise<void> {
  memoryDel(stateKey(provider));
  memoryDel(failuresKey(provider));
  memoryDel(badSecretKey(provider));
  try {
    await storeDel(stateKey(provider));
    await storeDel(failuresKey(provider));
    await storeDel(badSecretKey(provider));
  } catch (error) {
    console.error('[captcha] breaker reset could not reach the store', (error as Error).message);
  }
}

/** A network / 5xx failure of a real verification. Opens the breaker at the threshold. */
export async function recordProviderFailure(provider: ExternalCaptchaProvider): Promise<void> {
  let count: number;
  try {
    count = await storeIncr(failuresKey(provider), FAILURE_MEMORY_MS);
  } catch {
    count = memoryIncr(failuresKey(provider), FAILURE_MEMORY_MS);
  }
  if (count >= BREAKER_FAILURE_THRESHOLD) await openBreaker(provider, 'failures');
}

/** Any usable answer from the provider resets the consecutive-failure count. */
export async function recordProviderSuccess(provider: ExternalCaptchaProvider): Promise<void> {
  memoryDel(failuresKey(provider));
  try {
    await storeDel(failuresKey(provider));
  } catch {
    // the memory copy is reset; Redis expires its own copy
  }
}

const badSecretKey = (provider: ExternalCaptchaProvider) => captchaKey(`bad-secret-seen:${provider}`);
const BAD_SECRET_MEMORY_MS = 24 * 60 * 60_000;

/** A real verification got "invalid secret" back. Kept a day, for Doctor; never opens the breaker. */
export async function recordBadSecretSeen(provider: ExternalCaptchaProvider, now: number = Date.now()): Promise<void> {
  memorySet(badSecretKey(provider), String(now), BAD_SECRET_MEMORY_MS);
  try {
    await storeSet(badSecretKey(provider), String(now), BAD_SECRET_MEMORY_MS);
  } catch {
    // memory copy only
  }
}

/** When a real verification last got "invalid secret" (ms since the epoch), or null. */
export async function lastBadSecretSeen(provider: ExternalCaptchaProvider): Promise<number | null> {
  let raw: string | null;
  try {
    raw = await storeGet(badSecretKey(provider));
  } catch {
    raw = memoryGet(badSecretKey(provider));
  }
  const at = Number(raw);
  return raw && Number.isFinite(at) ? at : null;
}

export type ProbeResult = 'ok' | 'bad_secret' | 'unreachable';

export interface CachedProbe {
  result: ProbeResult;
  at: number;
}

async function rememberProbe(provider: ExternalCaptchaProvider, secret: string, result: ProbeResult, now: number): Promise<void> {
  const value = JSON.stringify({ result, at: now });
  memorySet(probeResultKey(provider, secret), value, 24 * 60 * 60_000);
  try {
    await storeSet(probeResultKey(provider, secret), value, 24 * 60 * 60_000);
  } catch {
    // memory copy only
  }
}

export async function lastProbe(provider: ExternalCaptchaProvider, secret: string): Promise<CachedProbe | null> {
  let raw: string | null;
  try {
    raw = await storeGet(probeResultKey(provider, secret));
  } catch {
    raw = memoryGet(probeResultKey(provider, secret));
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { result?: unknown; at?: unknown };
    if ((value.result === 'ok' || value.result === 'bad_secret' || value.result === 'unreachable') && typeof value.at === 'number') {
      return { result: value.result, at: value.at };
    }
  } catch {
    // ignore
  }
  return null;
}

/** Run the probe now, record its result, and open the breaker when it fails. */
export async function runProbe(provider: ExternalCaptchaProvider, secret: string, now: number = Date.now()): Promise<ProbeResult> {
  const result = await probeSiteverify(provider, secret);
  await rememberProbe(provider, secret, result, now);
  if (result === 'unreachable') await openBreaker(provider, 'probe');
  else if (result === 'bad_secret') await openBreaker(provider, 'bad_secret');
  else await recordProviderSuccess(provider);
  return result;
}

/**
 * The lazy probe of §5: runs at most once per 60 s per provider and secret
 * across all processes. When this call runs it, the probe's promise is
 * returned (wrapped, so awaiting the call does not wait for the probe);
 * null otherwise. Never throws.
 */
export async function maybeProbe(
  provider: ExternalCaptchaProvider,
  secret: string
): Promise<{ probe: Promise<ProbeResult> } | null> {
  let acquired: boolean;
  try {
    acquired = await storeSetNx(probeLockKey(provider, secret), '1', PROBE_INTERVAL_MS);
  } catch {
    acquired = memorySetNx(probeLockKey(provider, secret), '1', PROBE_INTERVAL_MS);
  }
  if (!acquired) return null;
  const probe = runProbe(provider, secret).catch((error: unknown): ProbeResult => {
    console.error('[captcha] reachability probe failed to run', (error as Error).message);
    return 'unreachable';
  });
  return { probe };
}
