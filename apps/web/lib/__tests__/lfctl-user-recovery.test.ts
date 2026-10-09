/**
 * The in-container half of `lfctl user …`: lib/operator-accounts.ts (the
 * database mocked) and scripts/operator-user.mjs under real Node.
 *
 *   - the password is hashed by the app's own `hashPassword` (scrypt, the
 *     same parameters and format as sign-up and the settings change);
 *   - the sign-up policy decides (MIN_PASSWORD_LENGTH … 128);
 *   - after the change EVERY session is revoked (`''` keeps none), the
 *     desktop handoff codes are dropped and the sign-in lock cleared — the
 *     password-reset route's machinery;
 *   - unknown / deleted / guest accounts change nothing and revoke nothing;
 *   - the entry script loads the app's TypeScript the way the web container
 *     does (Node's type stripping + the alias hooks) and speaks the
 *     stdin/stdout protocol lfctl relies on.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resetUserPasswordAsOperator, listInstanceAdminAccounts, revokeOtherSessions, revokeDesktopHandoffCodes, clearAccountAttempts } =
  vi.hoisted(() => ({
    resetUserPasswordAsOperator: vi.fn(),
    listInstanceAdminAccounts: vi.fn(),
    revokeOtherSessions: vi.fn(),
    revokeDesktopHandoffCodes: vi.fn(),
    clearAccountAttempts: vi.fn(),
  }));

const DB = { fake: 'db' };
vi.mock('@lobbyforge/db', () => ({ resetUserPasswordAsOperator, listInstanceAdminAccounts }));
vi.mock('@/lib/db', () => ({ getDb: () => DB }));
vi.mock('@/lib/session-tracker', () => ({ revokeOtherSessions }));
vi.mock('@/lib/desktop-handoff-codes', () => ({ revokeDesktopHandoffCodes }));
vi.mock('@/lib/auth-throttle', () => ({ clearAccountAttempts }));

import { DUMMY_PASSWORD_HASH, verifyPassword } from '@/lib/password';
import { MIN_PASSWORD_LENGTH } from '@/lib/password-strength';
import {
  MAX_PASSWORD_LENGTH,
  operatorExitCode,
  parseOperatorRequest,
  passwordPolicyError,
  runOperatorRequest,
} from '@/lib/operator-accounts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const GOOD_PASSWORD = 'correct horse battery staple';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  resetUserPasswordAsOperator.mockReset().mockResolvedValue({ ok: true, userId: USER_ID, email: 'owner@example.test', displayName: 'Ada' });
  listInstanceAdminAccounts.mockReset().mockResolvedValue([]);
  revokeOtherSessions.mockReset().mockResolvedValue(3);
  revokeDesktopHandoffCodes.mockReset().mockResolvedValue(1);
  clearAccountAttempts.mockReset().mockResolvedValue(undefined);
});

function reset(email: string, password: string) {
  return runOperatorRequest({ action: 'reset-password', email, password });
}

describe('operator password reset (lib/operator-accounts)', () => {
  it('hashes with the app scrypt format, sets it by email, and signs the account out everywhere', async () => {
    const response = await reset('  Owner@Example.TEST ', GOOD_PASSWORD);

    expect(response).toEqual({
      ok: true,
      action: 'reset-password',
      email: 'owner@example.test',
      displayName: 'Ada',
      sessionsRevoked: 3,
    });
    expect(operatorExitCode(response)).toBe(0);

    expect(resetUserPasswordAsOperator).toHaveBeenCalledTimes(1);
    const [db, input] = resetUserPasswordAsOperator.mock.calls[0]!;
    expect(db).toBe(DB);
    expect(input.email).toBe('owner@example.test');
    // Same hash format as everything else the app writes: scrypt$N$r$p$salt$key.
    const hash: string = input.newPasswordHash;
    expect(hash.split('$').slice(0, 4)).toEqual(DUMMY_PASSWORD_HASH.split('$').slice(0, 4));
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$/);
    expect(await verifyPassword(GOOD_PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(`${GOOD_PASSWORD}!`, hash)).toBe(false);
    // Never the password itself.
    expect(JSON.stringify(input)).not.toContain(GOOD_PASSWORD);

    // The password-reset route's machinery: no session is kept.
    expect(revokeOtherSessions).toHaveBeenCalledWith(USER_ID, '');
    expect(revokeDesktopHandoffCodes).toHaveBeenCalledWith(USER_ID);
    expect(clearAccountAttempts).toHaveBeenCalledWith({ scope: 'sign-in', email: 'owner@example.test' });
  });

  it('applies the sign-up policy before touching the database', async () => {
    expect(MAX_PASSWORD_LENGTH).toBe(128);
    for (const [password, error] of [
      ['', 'weak_password'],
      ['x'.repeat(MIN_PASSWORD_LENGTH - 1), 'weak_password'],
      ['x'.repeat(MAX_PASSWORD_LENGTH + 1), 'password_too_long'],
    ] as const) {
      const response = await reset('owner@example.test', password);
      expect(response).toEqual({ ok: false, error, minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH });
      expect(operatorExitCode(response)).toBe(2);
    }
    expect(resetUserPasswordAsOperator).not.toHaveBeenCalled();

    expect(passwordPolicyError('x'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(passwordPolicyError('x'.repeat(MAX_PASSWORD_LENGTH))).toBeNull();
    // UTF-16 code units, as the register route's zod `min(12)` counts.
    expect(passwordPolicyError('😀'.repeat(6))).toBeNull();
  });

  it.each([
    ['not_found', 'unknown_email'],
    ['deleted', 'deleted_account'],
    ['guest', 'guest_account'],
  ] as const)('a %s account changes nothing and revokes nothing', async (reason, error) => {
    resetUserPasswordAsOperator.mockResolvedValueOnce({ ok: false, reason });
    const response = await reset('who@example.test', GOOD_PASSWORD);
    expect(response).toEqual({ ok: false, error });
    expect(operatorExitCode(response)).toBe(2);
    expect(revokeOtherSessions).not.toHaveBeenCalled();
    expect(revokeDesktopHandoffCodes).not.toHaveBeenCalled();
    expect(clearAccountAttempts).not.toHaveBeenCalled();
  });

  it('reports a password changed with sessions still live (exit 3), never a silent success', async () => {
    revokeOtherSessions.mockRejectedValueOnce(new Error('redis down'));
    const response = await reset('owner@example.test', GOOD_PASSWORD);
    expect(response).toMatchObject({ ok: true, sessionsRevoked: null, warning: 'sessions_not_revoked' });
    expect(operatorExitCode(response)).toBe(3);
    expect(resetUserPasswordAsOperator).toHaveBeenCalledTimes(1);
  });

  it('carries on when the handoff codes or the sign-in lock cannot be cleared', async () => {
    revokeDesktopHandoffCodes.mockRejectedValueOnce(new Error('redis blip'));
    clearAccountAttempts.mockRejectedValueOnce(new Error('redis blip'));
    const response = await reset('owner@example.test', GOOD_PASSWORD);
    expect(response).toMatchObject({ ok: true, sessionsRevoked: 3 });
    expect(revokeOtherSessions).toHaveBeenCalledWith(USER_ID, '');
  });

  it('refuses something that is not an email address without a database call', async () => {
    for (const email of ['', 'owner', 'two words@example.test', `${'a'.repeat(320)}@x`]) {
      expect(await reset(email, GOOD_PASSWORD)).toEqual({ ok: false, error: 'invalid_email' });
    }
    expect(resetUserPasswordAsOperator).not.toHaveBeenCalled();
  });

  it('refuses malformed requests', async () => {
    for (const raw of [null, 'reset', [], {}, { action: 'drop-tables' }, { action: 'reset-password', email: 'a@b.c' }, { action: 'reset-password', email: 'a@b.c', password: 12345678901234 }]) {
      expect(parseOperatorRequest(raw)).toBeNull();
      expect(await runOperatorRequest(raw)).toEqual({ ok: false, error: 'invalid_request' });
    }
    expect(resetUserPasswordAsOperator).not.toHaveBeenCalled();
  });

  it('lists the admin accounts the database query returns', async () => {
    const accounts = [{ email: 'owner@example.test', displayName: 'Ada', instanceOwner: true, ownedServers: ['Home'] }];
    listInstanceAdminAccounts.mockResolvedValueOnce(accounts);
    const response = await runOperatorRequest({ action: 'list-admins' });
    expect(response).toEqual({ ok: true, action: 'list-admins', accounts });
    expect(listInstanceAdminAccounts).toHaveBeenCalledWith(DB);
    expect(operatorExitCode(response)).toBe(0);
  });
});

// ── The entry script under real Node, as the web container runs it ──────
const WEB_ROOT = join(__dirname, '..', '..');
const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
const canStripTypes = major > 22 || (major === 22 && minor >= 6);

function runEntry(args: string[], input?: string) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'scripts/operator-user.mjs', ...args],
    {
      cwd: WEB_ROOT,
      input,
      encoding: 'utf8',
      timeout: 60_000,
      // Nothing may reach a real database or Redis here.
      env: { ...process.env, DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none', REDIS_URL: 'redis://127.0.0.1:1', NODE_ENV: 'production' },
    }
  );
}

describe.skipIf(!canStripTypes)('scripts/operator-user.mjs under Node type stripping', () => {
  it('loads the app modules it reuses (the --self-check the container can run)', () => {
    const res = runEntry(['--self-check']);
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ ok: true, selfCheck: true, minLength: MIN_PASSWORD_LENGTH, maxLength: 128 });
  });

  it('answers one JSON line and exit 2 for a refused request, before any database work', () => {
    const weak = runEntry([], JSON.stringify({ action: 'reset-password', email: 'owner@example.test', password: 'short' }));
    expect(weak.status, weak.stderr).toBe(2);
    expect(JSON.parse(weak.stdout.trim())).toEqual({ ok: false, error: 'weak_password', minLength: MIN_PASSWORD_LENGTH, maxLength: 128 });

    const garbage = runEntry([], 'not json');
    expect(garbage.status, garbage.stderr).toBe(2);
    expect(JSON.parse(garbage.stdout.trim())).toEqual({ ok: false, error: 'invalid_request' });
  });
});
