import { beforeEach, describe, expect, it, vi } from 'vitest';

const { setMock, delMock } = vi.hoisted(() => ({
  setMock: vi.fn(),
  delMock: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  redis: { set: setMock, del: delMock },
}));

import { claimActionId, isValidActionId, releaseActionId } from '../action-idempotency.js';

const UUID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';

beforeEach(() => {
  setMock.mockReset();
  delMock.mockReset();
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

describe('claimActionId', () => {
  it('returns true and sets NX with a TTL when the key is fresh', async () => {
    setMock.mockResolvedValue('OK');
    await expect(claimActionId('session-1', UUID)).resolves.toBe(true);
    expect(setMock).toHaveBeenCalledWith(
      `lf:action-dedup:session-1:${UUID}`,
      '1',
      'EX',
      600,
      'NX'
    );
  });

  it('returns false when the id was already claimed (duplicate dispatch)', async () => {
    setMock.mockResolvedValue(null); // Redis SET NX miss
    await expect(claimActionId('session-1', UUID)).resolves.toBe(false);
  });

  it('scopes claims per session — the same id in another session is fresh', async () => {
    setMock.mockResolvedValue('OK');
    await expect(claimActionId('session-2', UUID)).resolves.toBe(true);
    expect(setMock).toHaveBeenCalledWith(
      `lf:action-dedup:session-2:${UUID}`,
      '1',
      'EX',
      600,
      'NX'
    );
  });
});

describe('releaseActionId', () => {
  it('deletes the claim key', async () => {
    delMock.mockResolvedValue(1);
    await releaseActionId('session-1', UUID);
    expect(delMock).toHaveBeenCalledWith(`lf:action-dedup:session-1:${UUID}`);
  });

  it('swallows redis errors (the TTL is the backstop)', async () => {
    delMock.mockRejectedValue(new Error('connection lost'));
    await expect(releaseActionId('session-1', UUID)).resolves.toBeUndefined();
  });
});
