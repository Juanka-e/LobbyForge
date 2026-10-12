/**
 * Sending one activity action, retrying what means "try again":
 *
 *  - the 409 the actions route answers when several players act at the
 *    same moment and its compare-and-swap loop runs out of attempts;
 *  - no answer at all (the network dropped: a tunnel, a Wi-Fi hand-over)
 *    and the route's retryable 503 (its claim store hiccuped). These are
 *    retried for a few seconds, so a tap made while the connection blinks
 *    still lands, instead of an error the player answers by tapping again.
 *
 * Every retry sends the SAME body, so the SAME `actionId`. The route claims
 * that id once (LF-002) and releases the claim when it refuses, so a retry
 * still runs the action exactly once — and if an earlier attempt did commit
 * after all (the answer was lost on the way back), the retry comes back as
 * a duplicate instead of running it twice.
 *
 * Every other answer is final: a duplicate, an ended activity, the wrong
 * game phase, a permission error, or any other 4xx/5xx.
 */

/** Attempts in all, the first included. */
export const CONFLICT_MAX_ATTEMPTS = 5;
/** Ceiling of the first wait; each later wait doubles it. */
export const CONFLICT_BASE_DELAY_MS = 150;

/** How long a lost answer or a retryable 503 is retried, waits included. */
export const TRANSIENT_RETRY_WINDOW_MS = 8_000;
/** The first wait after a lost answer; each later wait doubles, up to the cap. */
export const TRANSIENT_BASE_DELAY_MS = 250;
export const TRANSIENT_MAX_DELAY_MS = 2_000;

/**
 * The wait before retry number `retry` after a lost answer: 250 ms, then
 * doubling to a 2 s cap, with the same equal jitter. Seven attempts fit in
 * the default window.
 */
export function transientRetryDelayMs(retry: number, random: () => number = Math.random): number {
  const ceiling = Math.min(TRANSIENT_MAX_DELAY_MS, TRANSIENT_BASE_DELAY_MS * 2 ** retry);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * The wait before retry number `retry` (0 for the first retry):
 * exponential, with "equal jitter" — half the ceiling, plus a random share
 * of the other half — so players who collided once do not retry in step
 * and collide again. With the defaults the four waits add up to between
 * 1.1 and 2.3 seconds.
 */
export function conflictRetryDelayMs(retry: number, random: () => number = Math.random): number {
  const ceiling = CONFLICT_BASE_DELAY_MS * 2 ** retry;
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

interface RefusalBody {
  error?: unknown;
  code?: unknown;
  duplicate?: unknown;
  retryable?: unknown;
  revision?: unknown;
}

/**
 * A 409 worth retrying. The route marks the concurrency conflict with the
 * `revision` it lost the race to (or `retryable: true`); the other 409s —
 * ended activity, wrong phase, unknown plugin, duplicate — carry neither.
 */
export function isRetryableConflict(status: number, body: RefusalBody): boolean {
  if (status !== 409 || body.duplicate === true) return false;
  return body.retryable === true || typeof body.revision === 'number';
}

export type ActivityActionResult =
  | { kind: 'ok'; data: unknown }
  /** An earlier attempt already committed this action; re-read the session. */
  | { kind: 'duplicate' }
  | {
      kind: 'error';
      status: number;
      /** The server's own message, if it sent one (English; never shown as-is). */
      error: string | null;
      /** The machine reason (`not_host`, `session_ended`, … — see lib/activity-refusal.ts). */
      code: string | null;
      /** True when every attempt lost a concurrency race. */
      conflict: boolean;
    };

export interface ActivityActionOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  maxAttempts?: number;
  transientWindowMs?: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POST `payload` (which must already carry its `actionId`) to an
 * activity's actions route, retrying concurrency conflicts, lost answers
 * and retryable 503s with backoff. Throws the network error when the
 * server could not be reached for the whole window.
 */
export async function postActivityAction(
  url: string,
  payload: Record<string, unknown>,
  {
    fetchImpl = fetch,
    sleep = wait,
    random = Math.random,
    now = Date.now,
    maxAttempts = CONFLICT_MAX_ATTEMPTS,
    transientWindowMs = TRANSIENT_RETRY_WINDOW_MS,
  }: ActivityActionOptions = {}
): Promise<ActivityActionResult> {
  // Serialized once: every attempt is byte-for-byte the same request.
  const body = JSON.stringify(payload);
  const deadline = now() + transientWindowMs;
  let transientRetries = 0;
  /** Waits before the next transient retry; false once the window is spent. */
  const backOffTransient = async (): Promise<boolean> => {
    const delay = transientRetryDelayMs(transientRetries, random);
    if (now() + delay > deadline) return false;
    transientRetries += 1;
    await sleep(delay);
    return true;
  };
  for (let attempt = 1; ; ) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      // No answer: the action may or may not have run. The same actionId
      // makes the retry safe either way.
      if (await backOffTransient()) continue;
      throw err;
    }
    if (res.ok) {
      return { kind: 'ok', data: await res.json() };
    }
    const refusal = (await res.json().catch(() => ({}))) as RefusalBody;
    if (res.status === 409 && refusal.duplicate === true) {
      return { kind: 'duplicate' };
    }
    if (res.status === 503 && refusal.retryable === true && (await backOffTransient())) continue;
    const conflict = isRetryableConflict(res.status, refusal);
    if (!conflict || attempt >= maxAttempts) {
      return {
        kind: 'error',
        status: res.status,
        error: typeof refusal.error === 'string' ? refusal.error : null,
        code: typeof refusal.code === 'string' && refusal.code ? refusal.code : null,
        conflict,
      };
    }
    await sleep(conflictRetryDelayMs(attempt - 1, random));
    attempt += 1;
  }
}
