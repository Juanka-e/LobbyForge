/**
 * Challenges (docs/EMAIL.md §4.1) and the restriction rules (§4.2):
 *   - the code hash mixes the row id in; comparisons are constant-time;
 *   - a wrong code counts an attempt, the fifth is the last; expiry;
 *   - the link token is 32 bytes and only its hash is looked up;
 *   - who is restricted in `required` mode, and the gate's fast path.
 * The consumption race runs against real Postgres (email.integration.test.ts).
 */
import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getActiveEmailToken: vi.fn(),
  getEmailTokenByHash: vi.fn(),
  reserveEmailCodeAttempt: vi.fn(),
  replaceEmailToken: vi.fn(),
  deleteStaleEmailTokens: vi.fn(),
  getUserEmailState: vi.fn(),
  getInstanceSetupStatus: vi.fn(),
  resolveMailSettings: vi.fn(),
}));

vi.mock('@lobbyforge/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lobbyforge/db')>()),
  getActiveEmailToken: h.getActiveEmailToken,
  getEmailTokenByHash: h.getEmailTokenByHash,
  reserveEmailCodeAttempt: h.reserveEmailCodeAttempt,
  replaceEmailToken: h.replaceEmailToken,
  deleteStaleEmailTokens: h.deleteStaleEmailTokens,
  getUserEmailState: h.getUserEmailState,
  getInstanceSetupStatus: h.getInstanceSetupStatus,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('../settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings')>()),
  resolveMailSettings: h.resolveMailSettings,
}));

import { createHash } from 'node:crypto';
import { checkCode, checkLinkToken, codeMatches, generateCode, generateLinkToken, hashCode, hashLinkToken, issueChallenge, MAX_CODE_ATTEMPTS } from '../tokens';
import { emailRestrictionFor, isEmailRestricted, requireVerifiedEmail, signupInVerificationScope } from '../verification';

const UID = '88888888-8888-4888-8888-888888888888';
const NOW = new Date('2026-10-04T12:00:00Z');

function row(overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as string) ?? '99999999-9999-4999-8999-999999999999';
  return {
    id,
    userId: UID,
    purpose: 'verify',
    targetEmail: 'a@example.org',
    tokenHash: Buffer.alloc(32, 1),
    codeHash: hashCode(id, '123456'),
    codeAttempts: 0,
    expiresAt: new Date(NOW.getTime() + 24 * 3_600_000),
    codeExpiresAt: new Date(NOW.getTime() + 15 * 60_000),
    consumedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function settings(mode: 'off' | 'optional' | 'required', extra: Record<string, unknown> = {}) {
  return {
    verification: { mode, scope: { open_register: true, invite_register: false }, enforcedSince: new Date('2026-10-01T00:00:00Z'), existingDeadline: null, ...extra },
  };
}

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'q'.repeat(48));
  for (const fn of Object.values(h)) fn.mockReset();
  // Reserving an attempt counts it on the stored row (what the database does).
  h.reserveEmailCodeAttempt.mockImplementation(async () => {
    const current = await h.getActiveEmailToken();
    if (!current || current.codeAttempts >= MAX_CODE_ATTEMPTS) return null;
    return { ...current, codeAttempts: current.codeAttempts + 1 };
  });
  h.deleteStaleEmailTokens.mockResolvedValue(0);
  h.getInstanceSetupStatus.mockResolvedValue({ ownerUserId: 'owner-id' });
});

describe('codes and link tokens', () => {
  it('a code is 6 digits; its hash is bound to the row and compared in constant time', () => {
    for (let i = 0; i < 50; i += 1) expect(generateCode()).toMatch(/^\d{6}$/);
    expect(hashCode('row-a', '123456').equals(hashCode('row-b', '123456'))).toBe(false);
    expect(codeMatches(row(), '123456')).toBe(true);
    expect(codeMatches(row(), '123457')).toBe(false);
    // A different session secret, a different key.
    const before = hashCode('row-a', '123456');
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'w'.repeat(48));
    expect(hashCode('row-a', '123456').equals(before)).toBe(false);
  });

  it('a link token is 32 random bytes; only its sha256 is stored and looked up', () => {
    const { token, hash } = generateLinkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash.equals(createHash('sha256').update(Buffer.from(token, 'base64url')).digest())).toBe(true);
    expect(hashLinkToken(token)!.equals(hash)).toBe(true);
    expect(hashLinkToken('short')).toBeNull();
    expect(hashLinkToken(`${token.slice(0, 42)}!`)).toBeNull();
  });

  it('issuing replaces the live challenge with hashes only, 24 h link / 15 min code (reset: 60 min link)', async () => {
    h.replaceEmailToken.mockResolvedValue(undefined);
    const issued = await issueChallenge({ userId: UID, purpose: 'verify', targetEmail: 'a@example.org', now: NOW });
    const stored = h.replaceEmailToken.mock.calls[0]![1];
    expect(stored).toMatchObject({ id: issued.id, userId: UID, purpose: 'verify', targetEmail: 'a@example.org' });
    expect(stored.tokenHash.equals(hashLinkToken(issued.token))).toBe(true);
    expect(stored.codeHash.equals(hashCode(issued.id, issued.code))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(issued.code);
    expect(stored.expiresAt.getTime() - NOW.getTime()).toBe(24 * 3_600_000);
    expect(stored.codeExpiresAt.getTime() - NOW.getTime()).toBe(15 * 60_000);
    await issueChallenge({ userId: UID, purpose: 'reset', targetEmail: 'a@example.org', now: NOW });
    expect(h.replaceEmailToken.mock.calls[1]![1].expiresAt.getTime() - NOW.getTime()).toBe(60 * 60_000);
  });
});

describe('checkCode', () => {
  it('reserves an attempt BEFORE comparing, then accepts the right code', async () => {
    h.getActiveEmailToken.mockResolvedValue(row());
    const result = await checkCode(UID, 'verify', '123456', NOW);
    expect(result).toMatchObject({ ok: true, row: { codeAttempts: 1 } });
    expect(h.reserveEmailCodeAttempt).toHaveBeenCalledWith({}, expect.any(String), MAX_CODE_ATTEMPTS);
  });

  it('a wrong code uses its reserved attempt; the one that uses the last is too many', async () => {
    h.getActiveEmailToken.mockResolvedValue(row({ codeAttempts: 2 }));
    expect(await checkCode(UID, 'verify', '000000', NOW)).toEqual({ ok: false, error: 'invalid_code' });
    h.getActiveEmailToken.mockResolvedValue(row({ codeAttempts: 4 }));
    expect(await checkCode(UID, 'verify', '000000', NOW)).toEqual({ ok: false, error: 'too_many_attempts' });
    // The fifth attempt with the RIGHT code still works.
    expect(await checkCode(UID, 'verify', '123456', NOW)).toMatchObject({ ok: true, row: { codeAttempts: 5 } });
  });

  it('no reservation (a concurrent guess took the last attempt, or the challenge went): no comparison', async () => {
    h.getActiveEmailToken.mockResolvedValueOnce(row({ codeAttempts: 4 })).mockResolvedValue(row({ codeAttempts: 5 }));
    h.reserveEmailCodeAttempt.mockResolvedValueOnce(null);
    expect(await checkCode(UID, 'verify', '123456', NOW)).toEqual({ ok: false, error: 'too_many_attempts' });
    h.getActiveEmailToken.mockResolvedValueOnce(row()).mockResolvedValue(null);
    h.reserveEmailCodeAttempt.mockResolvedValueOnce(null);
    expect(await checkCode(UID, 'verify', '123456', NOW)).toEqual({ ok: false, error: 'invalid_code' });
  });

  it('the cap, before any reservation', async () => {
    // At the cap, even the right code is refused (the link still works).
    h.getActiveEmailToken.mockResolvedValue(row({ codeAttempts: 5 }));
    expect(await checkCode(UID, 'verify', '123456', NOW)).toEqual({ ok: false, error: 'too_many_attempts' });
  });

  it('refuses an expired code, and answers invalid_code without a live challenge', async () => {
    h.getActiveEmailToken.mockResolvedValue(row({ codeExpiresAt: new Date(NOW.getTime() - 1) }));
    expect(await checkCode(UID, 'verify', '123456', NOW)).toEqual({ ok: false, error: 'expired' });
    h.getActiveEmailToken.mockResolvedValue(null);
    expect(await checkCode(UID, 'verify', '123456', NOW)).toEqual({ ok: false, error: 'invalid_code' });
  });
});

describe('checkLinkToken', () => {
  it('finds a live challenge of the right purpose by the token hash', async () => {
    const { token, hash } = generateLinkToken();
    h.getEmailTokenByHash.mockResolvedValue(row({ tokenHash: hash }));
    expect(await checkLinkToken(token, 'verify', NOW)).toMatchObject({ ok: true });
    expect((h.getEmailTokenByHash.mock.calls[0]![1] as Buffer).equals(hash)).toBe(true);
    expect(await checkLinkToken(token, 'reset', NOW)).toEqual({ ok: false, error: 'invalid_token' });
    h.getEmailTokenByHash.mockResolvedValue(row({ tokenHash: hash, consumedAt: NOW }));
    expect(await checkLinkToken(token, 'verify', NOW)).toEqual({ ok: false, error: 'invalid_token' });
    h.getEmailTokenByHash.mockResolvedValue(row({ tokenHash: hash, expiresAt: new Date(NOW.getTime() - 1) }));
    expect(await checkLinkToken(token, 'verify', NOW)).toEqual({ ok: false, error: 'expired' });
    h.getEmailTokenByHash.mockResolvedValue(null);
    expect(await checkLinkToken(token, 'verify', NOW)).toEqual({ ok: false, error: 'invalid_token' });
    expect(await checkLinkToken('garbage', 'verify', NOW)).toEqual({ ok: false, error: 'invalid_token' });
  });
});

describe('who is restricted (§4.2)', () => {
  const base = {
    mode: 'required' as const,
    scope: { open_register: true, invite_register: false },
    enforcedSince: new Date('2026-10-01T00:00:00Z'),
    existingDeadline: null as Date | null,
    ownerUserId: 'owner-id' as string | null,
    user: {
      id: UID,
      email: 'a@example.org',
      emailVerifiedAt: null as Date | null,
      isGuest: false,
      createdAt: new Date('2026-10-02T00:00:00Z'),
      deletedAt: null,
      signupChannel: 'open' as 'open' | 'invite' | 'oauth' | 'setup' | null,
    },
  };

  it('an unverified account created after enforced_since, in required mode', () => {
    expect(isEmailRestricted(base, NOW)).toBe(true);
    expect(isEmailRestricted({ ...base, mode: 'optional' }, NOW)).toBe(false);
    expect(isEmailRestricted({ ...base, mode: 'off' }, NOW)).toBe(false);
  });

  it('never the verified, guests, accounts without an address, or the owner', () => {
    expect(isEmailRestricted({ ...base, user: { ...base.user, emailVerifiedAt: NOW } }, NOW)).toBe(false);
    expect(isEmailRestricted({ ...base, user: { ...base.user, isGuest: true } }, NOW)).toBe(false);
    expect(isEmailRestricted({ ...base, user: { ...base.user, email: null } }, NOW)).toBe(false);
    expect(isEmailRestricted({ ...base, ownerUserId: UID }, NOW)).toBe(false);
  });

  it('only accounts whose sign-up channel is in scope (an invite is already a gate by default)', () => {
    const invite = { ...base, user: { ...base.user, signupChannel: 'invite' as const } };
    expect(isEmailRestricted(invite, NOW)).toBe(false);
    expect(isEmailRestricted({ ...invite, scope: { open_register: true, invite_register: true } }, NOW)).toBe(true);
    expect(isEmailRestricted({ ...base, scope: { open_register: false, invite_register: true } }, NOW)).toBe(false);
    expect(isEmailRestricted({ ...base, user: { ...base.user, signupChannel: 'oauth' } }, NOW)).toBe(false);
    expect(isEmailRestricted({ ...base, user: { ...base.user, signupChannel: 'setup' } }, NOW)).toBe(false);
    // An account from before 0046 (no channel): the dates decide.
    expect(isEmailRestricted({ ...base, user: { ...base.user, signupChannel: null } }, NOW)).toBe(true);
    // Out of scope even after the existing-accounts deadline.
    expect(isEmailRestricted({ ...invite, existingDeadline: new Date('2026-10-03T00:00:00Z') }, NOW)).toBe(false);
  });

  it('existing accounts only once their deadline has passed', () => {
    const old = { ...base, user: { ...base.user, createdAt: new Date('2026-09-01T00:00:00Z') } };
    expect(isEmailRestricted(old, NOW)).toBe(false);
    expect(isEmailRestricted({ ...old, existingDeadline: new Date('2026-10-10T00:00:00Z') }, NOW)).toBe(false);
    expect(isEmailRestricted({ ...old, existingDeadline: new Date('2026-10-03T00:00:00Z') }, NOW)).toBe(true);
  });
});

describe('requireVerifiedEmail', () => {
  const unverified = { id: UID, email: 'a@example.org', emailVerifiedAt: null, isGuest: false, locale: 'en', displayName: 'A', createdAt: new Date(), deletedAt: null, hasPassword: true, signupChannel: 'open' };

  it('outside required mode answers from the settings alone (no account lookup)', async () => {
    h.resolveMailSettings.mockResolvedValue(settings('optional'));
    expect(await requireVerifiedEmail(UID, 'message')).toBeNull();
    expect(h.getUserEmailState).not.toHaveBeenCalled();
  });

  it('refuses a restricted account with 403 email_unverified; lets the verified through', async () => {
    h.resolveMailSettings.mockResolvedValue(settings('required'));
    h.getUserEmailState.mockResolvedValue(unverified);
    const refused = (await requireVerifiedEmail({ id: UID }, 'voice')) as NextResponse;
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'email_unverified' });
    h.getUserEmailState.mockResolvedValue({ ...unverified, emailVerifiedAt: new Date() });
    expect(await requireVerifiedEmail(UID, 'voice')).toBeNull();
  });

  it('fails open when the check itself breaks', async () => {
    h.resolveMailSettings.mockResolvedValue(settings('required'));
    h.getUserEmailState.mockRejectedValue(new Error('db down'));
    expect(await requireVerifiedEmail(UID, 'message')).toBeNull();
  });

  it('fails open when the owner cannot be looked up', async () => {
    h.resolveMailSettings.mockResolvedValue(settings('required'));
    h.getUserEmailState.mockResolvedValue(unverified);
    h.getInstanceSetupStatus.mockRejectedValue(new Error('db down'));
    expect(await requireVerifiedEmail(UID, 'message')).toBeNull();
    expect((await emailRestrictionFor(UID)).restricted).toBe(false);
  });

  it('emailRestrictionFor reports the owner as unrestricted', async () => {
    h.resolveMailSettings.mockResolvedValue(settings('required'));
    h.getInstanceSetupStatus.mockResolvedValue({ ownerUserId: UID });
    h.getUserEmailState.mockResolvedValue(unverified);
    expect((await emailRestrictionFor(UID)).restricted).toBe(false);
  });
});

describe('sign-up scope (§4.1)', () => {
  it('open sign-up by default, invite sign-up only when its scope is on, nothing in off mode', () => {
    const optional = settings('optional') as never;
    expect(signupInVerificationScope(optional, { invite: false })).toBe(true);
    expect(signupInVerificationScope(optional, { invite: true })).toBe(false);
    expect(signupInVerificationScope(settings('required', { scope: { open_register: false, invite_register: true } }) as never, { invite: true })).toBe(true);
    expect(signupInVerificationScope(settings('off') as never, { invite: false })).toBe(false);
  });
});
