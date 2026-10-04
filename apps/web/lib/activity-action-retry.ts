/**
 * Sending one activity action, retrying the single refusal that means
 * "try again": the 409 the actions route answers when several players act
 * at the same moment and its compare-and-swap loop runs out of attempts.
 *
 * Every retry sends the SAME body, so the SAME `actionId`. The route claims
 * that id once (LF-002) and releases the claim when it answers with this
 * conflict, so a retry still runs the action exactly once — and if an
 * earlier attempt did commit after all, the retry comes back as a
 * duplicate instead of running it twice.
 *
 * Every other answer is final: a duplicate, an ended activity, the wrong
 * game phase, a permission error, a 5xx, or a network failure.
 */

/** Attempts in all, the first included. */
export const CONFLICT_MAX_ATTEMPTS = 5;
/** Ceiling of the first wait; each later wait doubles it. */
export const CONFLICT_BASE_DELAY_MS = 150;

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
      /** The server's own message, if it sent one. */
      error: string | null;
      /** True when every attempt lost a concurrency race. */
      conflict: boolean;
    };

export interface ActivityActionOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POST `payload` (which must already carry its `actionId`) to an
 * activity's actions route, retrying concurrency conflicts with backoff.
 */
export async function postActivityAction(
  url: string,
  payload: Record<string, unknown>,
  {
    fetchImpl = fetch,
    sleep = wait,
    random = Math.random,
    maxAttempts = CONFLICT_MAX_ATTEMPTS,
  }: ActivityActionOptions = {}
): Promise<ActivityActionResult> {
  // Serialized once: every attempt is byte-for-byte the same request.
  const body = JSON.stringify(payload);
  for (let attempt = 1; ; attempt++) {
    const res = await fetchImpl(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (res.ok) {
      return { kind: 'ok', data: await res.json() };
    }
    const refusal = (await res.json().catch(() => ({}))) as RefusalBody;
    if (res.status === 409 && refusal.duplicate === true) {
      return { kind: 'duplicate' };
    }
    const conflict = isRetryableConflict(res.status, refusal);
    if (!conflict || attempt >= maxAttempts) {
      return {
        kind: 'error',
        status: res.status,
        error: typeof refusal.error === 'string' ? refusal.error : null,
        conflict,
      };
    }
    await sleep(conflictRetryDelayMs(attempt - 1, random));
  }
}
