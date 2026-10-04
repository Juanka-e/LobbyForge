import { describe, expect, it } from 'vitest';
import { providerPropsFor } from '../i18n/catalogue';
import {
  REDEEM_FAILURE_KEYS,
  classifyRedeemFailure,
  failureFromInvite,
  type RedeemFailure,
} from '../invite-redeem-error';

/**
 * Final-test finding (UX): the join page showed "redeem → 500 Failed to
 * redeem invite". Every refusal now maps to a translated message.
 */

describe('classifyRedeemFailure', () => {
  it.each<[number, string | undefined, RedeemFailure | 'checkInvite']>([
    [401, undefined, 'sessionExpired'],
    [404, undefined, 'revoked'],
    [409, undefined, 'alreadyMember'],
    [429, undefined, 'rateLimited'],
    [429, 'join_request_limit', 'requestLimit'],
    [500, undefined, 'generic'],
    [503, undefined, 'generic'],
    [400, undefined, 'generic'],
    // A bare 403/410 needs the invite's state to say which.
    [403, undefined, 'checkInvite'],
    [410, undefined, 'checkInvite'],
    // A code wins over the status.
    [403, 'banned', 'banned'],
    [403, 'invite_expired', 'expired'],
    [403, 'expired', 'expired'],
    [403, 'invite_exhausted', 'exhausted'],
    [403, 'not_found', 'revoked'],
    [429, 'rate_limited', 'rateLimited'],
    // An unknown code falls back to the status.
    [500, 'something_new', 'generic'],
    [403, 'toString', 'checkInvite'],
  ])('%i with code %s is %s', (status, code, expected) => {
    expect(classifyRedeemFailure(status, code)).toBe(expected);
  });
});

describe('a bare 403', () => {
  it("is a ban when the route's refusal says so — checked before anything about the invite", () => {
    expect(classifyRedeemFailure(403, undefined, 'You are banned from this server')).toBe('banned');
  });

  it('needs the invite state otherwise — the origin guard is never read as a ban', () => {
    expect(classifyRedeemFailure(403, undefined, 'Invite is unavailable')).toBe('checkInvite');
    expect(classifyRedeemFailure(403, undefined, 'Invalid request origin')).toBe('checkInvite');
    expect(classifyRedeemFailure(403, undefined, 'Cross-site request rejected')).toBe('checkInvite');
    // Only a 403 is read for the word.
    expect(classifyRedeemFailure(500, undefined, 'banned')).toBe('generic');
  });
});

describe('failureFromInvite', () => {
  it('reads an expired, used-up or vanished invite', () => {
    expect(failureFromInvite({ isExpired: true, isExhausted: false })).toBe('expired');
    expect(failureFromInvite({ isExpired: false, isExhausted: true })).toBe('exhausted');
    expect(failureFromInvite(null)).toBe('revoked');
  });

  it('leaves a refusal of a still-usable invite unexplained — never a guessed ban', () => {
    expect(failureFromInvite({ isExpired: false, isExhausted: false })).toBe('generic');
  });
});

describe('REDEEM_FAILURE_KEYS', () => {
  it.each(['en', 'tr'])('every message exists in %s, with no placeholders to fill', (locale) => {
    const { messages } = providerPropsFor(locale);
    for (const key of Object.values(REDEEM_FAILURE_KEYS)) {
      expect(messages[key], key).toBeTruthy();
      expect(messages[key], key).not.toMatch(/\{/);
    }
  });
});
