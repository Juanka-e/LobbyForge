import { beforeEach, describe, expect, it, vi } from 'vitest';

const { setMock, evalMock } = vi.hoisted(() => ({
  setMock: vi.fn(),
  evalMock: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  redis: { set: setMock, eval: evalMock },
}));

import {
  DuplicateActionError,
  claimActionId,
  isValidActionId,
  releaseActionId,
} from '../action-idempotency.js';

const UUID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';

beforeEach(() => {
  setMock.mockReset();
  evalMock.mockReset();
});

describe('isValidActionId', () => {
  it('accepts canonical UUIDs (case-insensitive)', () => {
    expect(isValidActionId(UUID)).toBe(true);
    expect(isValidActionId(UUID.toUpperCase())).toBe(true);
  });

  it('rejects non-UUID shapes', () => {
    expect(isValidActionId('not-a-uuid')).toBe(false);
    expect(isValidActionId('')).toBe(false);
    expect(isValidActionId(1234)).toBe(false);
    expect(isValidActionId(null)).toBe(false);
    expect(isValidActionId(undefined)).toBe(false);
    // Extra path traversal junk after a valid UUID is still rejected.
    expect(isValidActionId(`${UUID}\n/x`)).toBe(false);
  });
});

describe('claimActionId (V5-007 token claims)', () => {
  it('claims with SET NX + TTL and returns an ownership token', async () => {
    setMock.mockResolvedValue('OK');
    const claim = await claimActionId('session-1', UUID);
    expect(claim.sessionId).toBe('session-1');
    expect(claim.actionId).toBe(UUID);
    expect(claim.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(setMock).toHaveBeenCalledWith(
      `lf:action-dedup:session-1:${UUID}`,
      claim.token,
      'EX',
      600,
      'NX'
    );
  });

  it('each claim gets a FRESH token (never a constant)', async () => {
    setMock.mockResolvedValue('OK');
    const a = await claimActionId('session-1', UUID);
    const b = await claimActionId('session-2', UUID);
    expect(a.token).not.toBe(b.token);
  });

  it('rejects with DuplicateActionError when the id was already claimed', async () => {
    setMock.mockResolvedValue(null); // Redis SET NX miss
    await expect(claimActionId('session-1', UUID)).rejects.toBeInstanceOf(DuplicateActionError);
  });

  it('store failures propagate as ordinary errors (route maps them to 503)', async () => {
    setMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(claimActionId('session-1', UUID)).rejects.toThrow('ECONNREFUSED');
  });
});

describe('releaseActionId (compare-and-delete)', () => {
  it('deletes ONLY when the stored token matches the claim owner', async () => {
    evalMock.mockResolvedValue(1);
    const claim = { sessionId: 's', actionId: UUID, token: 'tok-1' };
    await releaseActionId(claim);
    // eval(script, numKeys, key, token)
    expect(evalMock).toHaveBeenCalledTimes(1);
    const args = evalMock.mock.calls[0]!;
    expect(args[1]).toBe(1);
    expect(args[2]).toBe(`lf:action-dedup:s:${UUID}`);
    expect(args[3]).toBe('tok-1');
    // The Lua script is a compare-and-delete, not a bare DEL.
    expect(String(args[0])).toContain('redis.call("get", KEYS[1]) == ARGV[1]');
  });

  it('swallows redis errors (the TTL is the backstop)', async () => {
    evalMock.mockRejectedValue(new Error('connection lost'));
    await expect(
      releaseActionId({ sessionId: 's', actionId: UUID, token: 'tok-1' })
    ).resolves.toBeUndefined();
  });
});
