import { describe, expect, it } from 'vitest';
import { normalizeInviteCode } from '../invite-code';

describe('invite-code', () => {
  it('accepts canonical 12 character invite codes', () => {
    expect(normalizeInviteCode('23456789ABCD')).toBe('23456789ABCD');
  });

  it('normalizes lowercase codes', () => {
    expect(normalizeInviteCode('23456789abcd')).toBe('23456789ABCD');
  });

  it('rejects ambiguous or wrong-length codes', () => {
    expect(normalizeInviteCode('23456789ABC')).toBeNull();
    expect(normalizeInviteCode('23456789ABCDE')).toBeNull();
    expect(normalizeInviteCode('23456789ABCU')).toBeNull();
    expect(normalizeInviteCode('23456789ABC1')).toBeNull();
  });
});
