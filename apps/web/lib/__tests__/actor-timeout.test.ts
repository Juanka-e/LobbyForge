import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * lib/actor-timeout.ts — the one refusal every management route gives a
 * timed-out actor (security review 2026-10, A1).
 */

const { getActiveMemberTimeout } = vi.hoisted(() => ({ getActiveMemberTimeout: vi.fn() }));
vi.mock('@lobbyforge/db', () => ({ getActiveMemberTimeout }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));

import { isWriteRequest, refuseTimedOutActor } from '../actor-timeout';

const SERVER = '11111111-1111-4111-8111-111111111111';
const OWNER = '44444444-4444-4444-8444-444444444444';
const MOD = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  getActiveMemberTimeout.mockReset().mockResolvedValue(null);
});

describe('refuseTimedOutActor', () => {
  it('answers 403 actor_timed_out with the end of the timeout', async () => {
    const until = new Date('2026-10-15T12:00:00.000Z');
    getActiveMemberTimeout.mockResolvedValue(until);
    const res = await refuseTimedOutActor(SERVER, MOD, OWNER);
    expect(res?.status).toBe(403);
    expect(await res!.json()).toEqual({
      error: 'You are timed out in this server',
      code: 'actor_timed_out',
      until: '2026-10-15T12:00:00.000Z',
    });
    expect(getActiveMemberTimeout).toHaveBeenCalledWith({ __mockDb: true }, SERVER, MOD);
  });

  it('lets a member who is not timed out act', async () => {
    expect(await refuseTimedOutActor(SERVER, MOD, OWNER)).toBeNull();
  });

  it('never refuses — nor asks about — the owner', async () => {
    getActiveMemberTimeout.mockResolvedValue(new Date(Date.now() + 60_000));
    expect(await refuseTimedOutActor(SERVER, OWNER, OWNER)).toBeNull();
    expect(getActiveMemberTimeout).not.toHaveBeenCalled();
  });

  it('asks when the owner is unknown', async () => {
    getActiveMemberTimeout.mockResolvedValue(new Date(Date.now() + 60_000));
    expect((await refuseTimedOutActor(SERVER, MOD, null))?.status).toBe(403);
    expect((await refuseTimedOutActor(SERVER, MOD, undefined))?.status).toBe(403);
  });
});

describe('isWriteRequest', () => {
  it('reads are GET and HEAD; everything else writes', () => {
    const at = 'https://example.test/x';
    expect(isWriteRequest(new Request(at))).toBe(false);
    expect(isWriteRequest(new Request(at, { method: 'HEAD' }))).toBe(false);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isWriteRequest(new Request(at, { method }))).toBe(true);
    }
  });
});
