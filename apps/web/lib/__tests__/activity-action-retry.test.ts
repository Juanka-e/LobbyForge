import { describe, expect, it, vi } from 'vitest';
import {
  CONFLICT_MAX_ATTEMPTS,
  conflictRetryDelayMs,
  isRetryableConflict,
  postActivityAction,
  TRANSIENT_RETRY_WINDOW_MS,
  transientRetryDelayMs,
} from '../activity-action-retry';

/**
 * Several players acting at once: the actions route can lose its
 * compare-and-swap race and answer 409 "too many concurrent actions".
 * The client retries THAT answer — with the same actionId. It also
 * retries, for a few seconds, a lost answer (the network dropped) and the
 * route's retryable 503: a tap made while the connection blinks lands.
 */

const URL = '/api/servers/srv/activities/sess/actions';
const ACTION_ID = '0b5c2f8e-4f1a-4c3e-9d2b-7a6e5f4d3c2b';
const CONFLICT = { error: 'Conflict: too many concurrent actions. Please retry.', revision: 7 };

function fakeFetch(...answers: Array<() => Response>) {
  const bodies: string[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit = {}) => {
    bodies.push(String(init.body));
    const next = answers[Math.min(bodies.length - 1, answers.length - 1)];
    return next();
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies, calls: fetchImpl };
}

const conflict = () => Response.json(CONFLICT, { status: 409 });
const ok = () => Response.json({ activity: { state: { round: 2 }, status: 'running' } });

/** A fake clock: every wait moves it forward, so the retry window ends. */
function run(fetchImpl: typeof fetch) {
  let clock = 0;
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  return {
    sleep,
    elapsed: () => clock,
    result: postActivityAction(
      URL,
      { actionId: ACTION_ID, type: 'vote' },
      { fetchImpl, sleep, random: () => 0.5, now: () => clock }
    ),
  };
}

describe('isRetryableConflict', () => {
  it('is true for the concurrency conflict (it carries the revision it lost to)', () => {
    expect(isRetryableConflict(409, CONFLICT)).toBe(true);
    expect(isRetryableConflict(409, { retryable: true })).toBe(true);
  });

  it('is false for every other 409 and every other status', () => {
    expect(isRetryableConflict(409, { error: 'Duplicate action — already processed.', duplicate: true, revision: 3 })).toBe(false);
    expect(isRetryableConflict(409, { error: 'Activity has ended.' })).toBe(false);
    expect(isRetryableConflict(409, { error: 'Not the voting phase' })).toBe(false);
    const pluginGone = { error: 'Plugin not registered', pluginId: 'x' };
    expect(isRetryableConflict(409, pluginGone)).toBe(false);
    expect(isRetryableConflict(503, { error: 'please retry', retryable: true })).toBe(false);
    expect(isRetryableConflict(500, CONFLICT)).toBe(false);
  });
});

describe('conflictRetryDelayMs', () => {
  it('doubles each time, with jitter between half and all of the ceiling', () => {
    expect(conflictRetryDelayMs(0, () => 0)).toBe(75);
    expect(conflictRetryDelayMs(0, () => 1)).toBe(150);
    expect(conflictRetryDelayMs(1, () => 0)).toBe(150);
    expect(conflictRetryDelayMs(3, () => 1)).toBe(1200);
  });

  it('keeps every wait together within roughly two to three seconds', () => {
    const retries = CONFLICT_MAX_ATTEMPTS - 1;
    let longest = 0;
    let shortest = 0;
    for (let i = 0; i < retries; i++) {
      longest += conflictRetryDelayMs(i, () => 1);
      shortest += conflictRetryDelayMs(i, () => 0);
    }
    expect(retries).toBeGreaterThanOrEqual(3);
    expect(shortest).toBeGreaterThanOrEqual(1000);
    expect(longest).toBeLessThanOrEqual(2500);
  });
});

describe('postActivityAction', () => {
  it('retries a conflict with the SAME actionId and returns the success', async () => {
    const { fetchImpl, bodies } = fakeFetch(conflict, conflict, ok);
    const { result, sleep } = run(fetchImpl);
    await expect(result).resolves.toEqual({
      kind: 'ok',
      data: { activity: { state: { round: 2 }, status: 'running' } },
    });
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ actionId: ACTION_ID, type: 'vote' });
    // Backoff between attempts: one wait per retry, growing.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([conflictRetryDelayMs(0, () => 0.5), conflictRetryDelayMs(1, () => 0.5)]);
  });

  it('reports the conflict only after every attempt lost the race', async () => {
    const { fetchImpl, calls } = fakeFetch(conflict);
    const { result, sleep } = run(fetchImpl);
    await expect(result).resolves.toEqual({
      kind: 'error',
      status: 409,
      error: CONFLICT.error,
      code: null,
      conflict: true,
    });
    expect(calls).toHaveBeenCalledTimes(CONFLICT_MAX_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(CONFLICT_MAX_ATTEMPTS - 1);
  });

  it('treats a duplicate on a retry as already done', async () => {
    const { fetchImpl } = fakeFetch(conflict, () =>
      Response.json({ error: 'Duplicate action — already processed.', duplicate: true }, { status: 409 })
    );
    await expect(run(fetchImpl).result).resolves.toEqual({ kind: 'duplicate' });
  });

  it.each([
    ['an ended activity', 409, { error: 'Activity has ended.' }],
    ['the wrong phase', 409, { error: 'Not the voting phase' }],
    ['a permission error', 403, { error: 'Player is not in this activity' }],
    ['a validation error', 400, { error: 'Invalid action body' }],
    ['a server error', 500, { error: 'Failed to prepare action' }],
    ['a 503 that does not say retryable', 503, { error: 'Guest user has no materialized user record' }],
  ])('does not retry %s', async (_label, status, body) => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json(body, { status }));
    const { result, sleep } = run(fetchImpl);
    await expect(result).resolves.toEqual({ kind: 'error', status, error: body.error, code: null, conflict: false });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ['session_ended', 409],
    ['not_host', 403],
    ['voice_required', 403],
    ['rate_limited', 429],
  ])('passes the machine code %s through without retrying', async (code, status) => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ error: 'English text', code }, { status }));
    await expect(run(fetchImpl).result).resolves.toEqual({ kind: 'error', status, error: 'English text', code, conflict: false });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  const offline = () => {
    throw new TypeError('Failed to fetch');
  };

  it('retries a lost answer with the SAME actionId and returns the success', async () => {
    const { fetchImpl, bodies } = fakeFetch(offline, offline, ok);
    await expect(run(fetchImpl).result).resolves.toEqual({
      kind: 'ok',
      data: { activity: { state: { round: 2 }, status: 'running' } },
    });
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies)).toEqual(new Set([JSON.stringify({ actionId: ACTION_ID, type: 'vote' })]));
  });

  it('reads "already done" when the lost answer had in fact committed', async () => {
    // The first attempt ran; its answer never arrived. The retry is
    // refused as a duplicate, and the caller re-reads the session.
    const { fetchImpl } = fakeFetch(offline, () =>
      Response.json({ error: 'Duplicate action — already processed.', duplicate: true }, { status: 409 })
    );
    await expect(run(fetchImpl).result).resolves.toEqual({ kind: 'duplicate' });
  });

  it('gives up on an unreachable server once the window is spent, with the network error', async () => {
    const fetchImpl = vi.fn(async () => offline()) as unknown as typeof fetch;
    const { result, sleep, elapsed } = run(fetchImpl);
    await expect(result).rejects.toThrow('Failed to fetch');
    expect(elapsed()).toBeLessThanOrEqual(TRANSIENT_RETRY_WINDOW_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(sleep.mock.calls.length + 1);
    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('retries the claim store’s retryable 503, then reports it if it never recovers', async () => {
    const unavailable = { error: 'Action service temporarily unavailable — please retry.', retryable: true };
    const recovers = fakeFetch(() => Response.json(unavailable, { status: 503 }), ok);
    await expect(run(recovers.fetchImpl).result).resolves.toMatchObject({ kind: 'ok' });
    expect(recovers.bodies).toHaveLength(2);

    const stays = fakeFetch(() => Response.json(unavailable, { status: 503 }));
    const { result, elapsed } = run(stays.fetchImpl);
    await expect(result).resolves.toEqual({ kind: 'error', status: 503, error: unavailable.error, code: null, conflict: false });
    expect(stays.calls.mock.calls.length).toBeGreaterThan(1);
    expect(elapsed()).toBeLessThanOrEqual(TRANSIENT_RETRY_WINDOW_MS);
  });

  it('waits a little longer after each lost answer, up to two seconds', () => {
    expect(transientRetryDelayMs(0, () => 1)).toBe(250);
    expect(transientRetryDelayMs(1, () => 1)).toBe(500);
    expect(transientRetryDelayMs(3, () => 1)).toBe(2_000);
    expect(transientRetryDelayMs(9, () => 1)).toBe(2_000);
    expect(transientRetryDelayMs(9, () => 0)).toBe(1_000);
  });

  it('copes with a refusal that has no JSON body', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('upstream down', { status: 502 }));
    await expect(run(fetchImpl).result).resolves.toEqual({ kind: 'error', status: 502, error: null, code: null, conflict: false });
  });
});
