/**
 * The signals behind adaptive sign-in (docs/CAPTCHA.md §2, §7), on top of
 * the per-account counter of `lib/auth-throttle.ts`:
 *
 * - per client address: failed sign-ins in the auth-throttle window
 *   (15 min). Only counted when the app can tell clients apart — without a
 *   trusted proxy every visitor is "unknown" and one bucket would put the
 *   whole instance behind the challenge (attack mode covers that case);
 * - instance-wide: failed sign-ins in a 10-minute window. Over 50 turns
 *   attack mode on automatically for 30 minutes (it then ends on its own;
 *   if the failures go on, the next window turns it on again). The admin
 *   can also turn it on by hand (`captcha_attack_mode`).
 *
 * A "failed sign-in" is a wrong email/password answer (401) from
 * /api/auth/login or /api/auth/desktop-session. Keys hold a hash of the
 * address, never the address, under `lf:<env>:rate-limit:captcha-*`, so the
 * e2e reset clears them. When the store is down the signals read as quiet:
 * the account limiter itself fails closed in that case.
 */
import { createHash } from 'node:crypto';
import { SIGN_IN_ACCOUNT_LIMIT } from '@/lib/auth-throttle';
import { resolveClientAddress } from '@/lib/security-headers';
import { captchaCounterKey, memoryGet, memoryIncr, memorySetNx, storeGet, storeIncr, storeSetNx } from './store';

export const ATTACK_MODE_THRESHOLD = 50;
export const ATTACK_MODE_WINDOW_MS = 10 * 60_000;
export const ATTACK_MODE_DURATION_MS = 30 * 60_000;
export const ADDRESS_FAILURE_WINDOW_MS = SIGN_IN_ACCOUNT_LIMIT.windowMs;

const instanceFailuresKey = () => captchaCounterKey('signin-failures');
const attackUntilKey = () => captchaCounterKey('attack-until');

function addressKey(address: string): string {
  return captchaCounterKey(`address-failures:${createHash('sha256').update(`lobbyforge:${address}`).digest('hex').slice(0, 32)}`);
}

/** The client address the rate limiter trusts, or null when it cannot tell clients apart. */
export function signalAddress(req: Request): string | null {
  const address = resolveClientAddress(req);
  return address && address !== 'unknown' ? address : null;
}

async function incr(key: string, windowMs: number): Promise<number | null> {
  try {
    return await storeIncr(key, windowMs);
  } catch {
    if (process.env.NODE_ENV === 'production') return null;
    return memoryIncr(key, windowMs);
  }
}

async function read(key: string): Promise<string | null> {
  try {
    return await storeGet(key);
  } catch {
    return process.env.NODE_ENV === 'production' ? null : memoryGet(key);
  }
}

/** Count one failed sign-in (call after a wrong email/password). Never throws. */
export async function recordSignInFailure(req: Request, now: number = Date.now()): Promise<void> {
  try {
    const address = signalAddress(req);
    if (address) await incr(addressKey(address), ADDRESS_FAILURE_WINDOW_MS);
    const instanceFailures = await incr(instanceFailuresKey(), ATTACK_MODE_WINDOW_MS);
    if (instanceFailures !== null && instanceFailures > ATTACK_MODE_THRESHOLD) {
      const until = String(now + ATTACK_MODE_DURATION_MS);
      let started: boolean;
      try {
        started = await storeSetNx(attackUntilKey(), until, ATTACK_MODE_DURATION_MS);
      } catch {
        started = memorySetNx(attackUntilKey(), until, ATTACK_MODE_DURATION_MS);
      }
      if (started) {
        console.warn(`[captcha] attack mode on for ${ATTACK_MODE_DURATION_MS / 60_000} min: more than ${ATTACK_MODE_THRESHOLD} failed sign-ins in ${ATTACK_MODE_WINDOW_MS / 60_000} min`);
      }
    }
  } catch (error) {
    console.error('[captcha] failed sign-in could not be counted', (error as Error).message);
  }
}

/** Failed sign-ins from this request's address in the current window (0 when unknown or unreadable). */
export async function addressFailureCount(req: Request): Promise<number> {
  const address = signalAddress(req);
  if (!address) return 0;
  return Number(await read(addressKey(address))) || 0;
}

/** When automatic attack mode ends (ms since the epoch), or null when it is off. */
export async function attackModeAutoUntil(now: number = Date.now()): Promise<number | null> {
  const until = Number(await read(attackUntilKey()));
  return Number.isFinite(until) && until > now ? until : null;
}
