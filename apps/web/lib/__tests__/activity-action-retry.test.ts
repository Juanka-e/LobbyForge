import { describe, expect, it, vi } from 'vitest';
import {
  CONFLICT_MAX_ATTEMPTS,
  conflictRetryDelayMs,
  isRetryableConflict,
  postActivityAction,
} from '../activity-action-retry';

/**
 * Several players acting at once: the actions route can lose its
 * compare-and-swap race and answer 409 "too many concurrent actions".
 * The client retries THAT answer — with the same actionId — and nothing
 * else.
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

function run(fetchImpl: typeof fetch, sleep = vi.fn(async (_ms: number) => {})) {
  return {
    sleep,
    result: postActivityAction(URL, { actionId: ACTION_ID, type: 'vote' }, { fetchImpl, sleep, random: () => 0.5 }),
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
    ['an unavailable claim store', 503, { error: 'Action service temporarily unavailable — please retry.', retryable: true }],
  ])('does not retry %s', async (_label, status, body) => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json(body, { status }));
    const { result, sleep } = run(fetchImpl);
    await expect(result).resolves.toEqual({ kind: 'error', status, error: body.error, conflict: false });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry a network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const { result, sleep } = run(fetchImpl);
    await expect(result).rejects.toThrow('Failed to fetch');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('copes with a refusal that has no JSON body', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('upstream down', { status: 502 }));
    await expect(run(fetchImpl).result).resolves.toEqual({ kind: 'error', status: 502, error: null, conflict: false });
  });
});
