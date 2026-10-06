import { describe, expect, it } from 'vitest';
import {
  codeRefusalNotice,
  formatCountdown,
  isEmailUnverified,
  isRestricted,
  needsVerification,
  normalizeCode,
  parseEmailStatus,
  retryInstant,
  secondsUntil,
  sendRefusalNotice,
  type EmailStatus,
} from '../email-status';
import { linkTokenFrom } from '../link-token';

const status = (overrides: Partial<EmailStatus> = {}): EmailStatus => ({
  email: 'ada@example.org',
  verified: false,
  mode: 'optional',
  restricted: false,
  pendingChange: null,
  resendAvailableAt: null,
  mailConfigured: true,
  ...overrides,
});

describe('email status (EMAIL.md §4.3)', () => {
  it('reads the status answer defensively', () => {
    expect(
      parseEmailStatus({
        email: 'ada@example.org',
        verified: false,
        mode: 'required',
        restricted: true,
        pendingChange: 'new@example.org',
        resendAvailableAt: '2026-10-04T10:00:00.000Z',
        mailConfigured: true,
      })
    ).toEqual({
      email: 'ada@example.org',
      verified: false,
      mode: 'required',
      restricted: true,
      pendingChange: 'new@example.org',
      resendAvailableAt: '2026-10-04T10:00:00.000Z',
      mailConfigured: true,
    });
    // Unknown mode → off; junk → null fields; no `verified` → not a status at all.
    expect(parseEmailStatus({ verified: true, mode: 'sometimes', resendAvailableAt: 'soon', email: '' })).toMatchObject({
      mode: 'off',
      resendAvailableAt: null,
      email: null,
      restricted: false,
      mailConfigured: false,
    });
    expect(parseEmailStatus({ error: 'unauthorized' })).toBeNull();
    expect(parseEmailStatus(null)).toBeNull();
  });

  it('asks for verification only for an unverified address on an instance that wants it', () => {
    expect(needsVerification(status())).toBe(true);
    expect(needsVerification(status({ mode: 'required' }))).toBe(true);
    expect(needsVerification(status({ mode: 'off' }))).toBe(false);
    expect(needsVerification(status({ verified: true }))).toBe(false);
    // Guests have no address.
    expect(needsVerification(status({ email: null }))).toBe(false);
    expect(needsVerification(null)).toBe(false);
  });

  it('is restricted only when the server says so and the address is not verified', () => {
    expect(isRestricted(status({ mode: 'required', restricted: true }))).toBe(true);
    expect(isRestricted(status({ mode: 'required', restricted: false }))).toBe(false);
    expect(isRestricted(status({ restricted: true, verified: true }))).toBe(false);
    expect(isRestricted(null)).toBe(false);
  });

  it('recognises the email_unverified refusal and nothing else', () => {
    expect(isEmailUnverified(403, { error: 'email_unverified' })).toBe(true);
    expect(isEmailUnverified(403, { error: 'forbidden' })).toBe(false);
    expect(isEmailUnverified(400, { error: 'email_unverified' })).toBe(false);
    expect(isEmailUnverified(403, null)).toBe(false);
  });

  it('keeps the digits of a pasted code', () => {
    expect(normalizeCode('123 456')).toBe('123456');
    expect(normalizeCode('12-34-56-78')).toBe('123456');
    expect(normalizeCode('abc')).toBe('');
  });

  it('counts down to an instant', () => {
    const now = Date.parse('2026-10-04T10:00:00.000Z');
    expect(secondsUntil('2026-10-04T10:00:42.100Z', now)).toBe(43);
    expect(secondsUntil('2026-10-04T09:59:00.000Z', now)).toBe(0);
    expect(secondsUntil(null, now)).toBe(0);
    expect(formatCountdown(42)).toBe('0:42');
    expect(formatCountdown(605)).toBe('10:05');
    expect(retryInstant(30, now)).toBe('2026-10-04T10:00:30.000Z');
    expect(retryInstant('nope', now)).toBeNull();
  });

  it('turns every code refusal into a sentence key', () => {
    expect(codeRefusalNotice(400, { error: 'invalid_code' }).key).toBe('emailVerification.code.error.invalid');
    expect(codeRefusalNotice(400, { error: 'expired' }).key).toBe('emailVerification.code.error.expired');
    expect(codeRefusalNotice(400, { error: 'too_many_attempts' }).key).toBe('emailVerification.code.error.tooMany');
    expect(codeRefusalNotice(400, { error: 'invalid_token' }).key).toBe('emailVerification.code.error.invalidToken');
    expect(codeRefusalNotice(409, { error: 'email_taken' }).key).toBe('emailVerification.change.error.taken');
    expect(codeRefusalNotice(429, {}).key).toBe('emailVerification.error.rateLimited');
    expect(codeRefusalNotice(500, { error: 'Something in English' }).key).toBe('emailVerification.code.error.generic');
  });

  it('turns every send refusal into a sentence key', () => {
    expect(sendRefusalNotice(429, { error: 'rate_limited', retryAfter: 40 }).key).toBe('emailVerification.error.rateLimited');
    expect(sendRefusalNotice(503, { error: 'mail_unavailable' }).key).toBe('emailVerification.error.mailUnavailable');
    expect(sendRefusalNotice(503, { error: 'mail_quota' }).key).toBe('emailVerification.error.mailQuota');
    expect(sendRefusalNotice(409, { error: 'already_verified' }).key).toBe('emailVerification.code.error.alreadyVerified');
    expect(sendRefusalNotice(500, {}).key).toBe('emailVerification.error.sendFailed');
  });

  it('offers a button only for a token that looks like one', () => {
    expect(linkTokenFrom('A'.repeat(43))).toBe('A'.repeat(43));
    expect(linkTokenFrom(' abc_DEF-123456789012345 ')).toBe('abc_DEF-123456789012345');
    expect(linkTokenFrom(undefined)).toBeNull();
    expect(linkTokenFrom(['a', 'b'])).toBeNull();
    expect(linkTokenFrom('short')).toBeNull();
    expect(linkTokenFrom('<script>alert(1)</script>aaaaaaaa')).toBeNull();
    expect(linkTokenFrom('x'.repeat(600))).toBeNull();
  });
});
