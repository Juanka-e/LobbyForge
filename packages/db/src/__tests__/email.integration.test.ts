/**
 * Email (0046) against real Postgres:
 *   - the backfill marks only accounts whose Google link says the address
 *     is verified, and re-running it changes nothing;
 *   - the mail settings: defaults for a row the previous image wrote,
 *     partial updates, the CHECK backstops, enforced_since set once;
 *   - challenges: a new send replaces the live one, one live row per user
 *     and purpose, expiry, the code attempt cap, and the consumption race
 *     (of many concurrent submissions exactly one wins);
 *   - the actions they prove: verify, change (the address must still be
 *     free) and reset.
 *
 * Uses its own users and instance ids, never the 'self-host' singleton other
 * suites read. Skipped unless TEST_DATABASE_URL points at a migrated
 * scratch Postgres.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDb } from '../client.js';
import {
  applyEmailChange,
  applyEmailVerification,
  applyPasswordReset,
  changeUserEmailDirect,
  deleteStaleEmailTokens,
  getActiveEmailToken,
  getEmailTokenByHash,
  getUserEmailState,
  getUserEmailStateByEmail,
  listUserEmailVerification,
  markUserEmailVerified,
  markUserEmailVerifiedForAddress,
  reserveEmailCodeAttempt,
  replaceEmailToken,
  revokeEmailChallenges,
  type EmailTokenPurpose,
} from '../queries/email.js';
import {
  DEFAULT_DISPOSABLE_EMAIL_OVERRIDES,
  DEFAULT_EMAIL_VERIFICATION_SCOPE,
  ensureEmailVerificationEnforcedSince,
  getInstanceMailSettings,
  recordInstanceMailTest,
  setInstanceMailSettings,
} from '../queries/instanceSettings.js';
import { createLocalAccount, findOrCreateGuestUser, replaceUserPasswordHash } from '../queries/users.js';

const DB_URL = process.env.TEST_DATABASE_URL;
const ENCRYPTED = 'v1.aXYtaXYtaXYtaXY.Y2lwaGVydGV4dA.dGFnLXRhZy10YWctdGFn';
const HOUR = 60 * 60_000;

describe.skipIf(!DB_URL)('email (integration)', () => {
  const sql = DB_URL ? postgres(DB_URL, { max: 8 }) : (null as unknown as postgres.Sql);
  const db = DB_URL ? createDb(DB_URL) : (null as unknown as ReturnType<typeof createDb>);
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const instanceIds: string[] = [];

  async function createUser(opts: { email?: string | null; guest?: boolean; verified?: boolean } = {}): Promise<{ id: string; email: string | null }> {
    const email = opts.email === undefined ? `u-${randomUUID()}@example.test` : opts.email;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO users (email, display_name, password_hash, is_guest, email_verified_at)
      VALUES (${email}, 'Mail Test', 'scrypt$old', ${opts.guest ?? false}, ${opts.verified ? new Date() : null})
      RETURNING id`;
    userIds.push(row!.id);
    return { id: row!.id, email };
  }

  async function newToken(userId: string, purpose: EmailTokenPurpose, targetEmail: string, opts: { linkMs?: number; codeMs?: number } = {}) {
    const raw = randomBytes(32);
    const tokenHash = createHash('sha256').update(raw).digest();
    const row = await replaceEmailToken(db, {
      id: randomUUID(),
      userId,
      purpose,
      targetEmail,
      tokenHash,
      codeHash: randomBytes(32),
      expiresAt: new Date(Date.now() + (opts.linkMs ?? 24 * HOUR)),
      codeExpiresAt: new Date(Date.now() + (opts.codeMs ?? 15 * 60_000)),
    });
    return { row, tokenHash };
  }

  afterAll(async () => {
    if (userIds.length) await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
    if (instanceIds.length) await sql`DELETE FROM instance_settings WHERE instance_id IN ${sql(instanceIds)}`;
    await sql.end();
  });

  describe('backfill', () => {
    const backfill = readFileSync(join(__dirname, '..', '..', 'drizzle', '0046_email.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
      .find((statement) => statement.startsWith('UPDATE'))!;

    it('verifies accounts whose verified Google address IS their address, keeps earlier timestamps, and is idempotent', async () => {
      const googleVerified = await createUser();
      const googleUnverified = await createUser();
      const otherAddress = await createUser();
      const noAddress = await createUser({ email: null, guest: true });
      const local = await createUser();
      const earlier = await createUser();
      const earlierAt = new Date('2026-01-02T03:04:05Z');
      await sql`UPDATE users SET email_verified_at = ${earlierAt} WHERE id = ${earlier.id}`;
      for (const [user, verified, providerEmail] of [
        [googleVerified, true, googleVerified.email!.toUpperCase()],
        [googleUnverified, false, googleUnverified.email!],
        [otherAddress, true, 'someone-else@example.test'],
        [noAddress, true, 'g@example.test'],
        [earlier, true, earlier.email!],
      ] as const) {
        await sql`
          INSERT INTO user_identity_links (user_id, provider, provider_subject, provider_email, email_verified)
          VALUES (${user.id}, 'google', ${`sub-${randomUUID()}`}, ${providerEmail}, ${verified})`;
      }
      // A link from another provider never counts.
      await sql`
        INSERT INTO user_identity_links (user_id, provider, provider_subject, email_verified)
        VALUES (${local.id}, 'github', ${`sub-${randomUUID()}`}, true)`;

      await sql.unsafe(backfill);
      const read = async (id: string) =>
        (await sql<{ email_verified_at: Date | null }[]>`SELECT email_verified_at FROM users WHERE id = ${id}`)[0]!.email_verified_at;
      const first = await read(googleVerified.id);
      expect(first).toBeInstanceOf(Date);
      expect(await read(googleUnverified.id)).toBeNull();
      expect(await read(otherAddress.id)).toBeNull();
      expect(await read(noAddress.id)).toBeNull();
      expect(await read(local.id)).toBeNull();
      expect((await read(earlier.id))!.toISOString()).toBe(earlierAt.toISOString());

      await sql.unsafe(backfill);
      expect((await read(googleVerified.id))!.toISOString()).toBe(first!.toISOString());
    });
  });

  describe('mail settings', () => {
    it('a row written by the previous image reads the 0046 defaults; no row reads them too', async () => {
      const legacy = `mail-legacy-${run}`;
      instanceIds.push(legacy);
      await sql`INSERT INTO instance_settings (instance_id, instance_name) VALUES (${legacy}, 'Legacy')`;
      expect(await getInstanceMailSettings(db, legacy)).toMatchObject({
        provider: 'none',
        smtpHost: null,
        smtpPasswordEncrypted: null,
        verificationMode: 'off',
        verificationScope: DEFAULT_EMAIL_VERIFICATION_SCOPE,
        enforcedSince: null,
        disposableBlock: false,
        disposableOverrides: DEFAULT_DISPOSABLE_EMAIL_OVERRIDES,
      });
      const missing = `mail-missing-${run}`;
      expect(await getInstanceMailSettings(db, missing)).toMatchObject({ provider: 'none', verificationMode: 'off', updatedAt: null });
    });

    it('creates the row on first save, updates only the fields given, and records a test without touching updated_at', async () => {
      const fresh = `mail-fresh-${run}`;
      instanceIds.push(fresh);
      const created = await setInstanceMailSettings(db, {
        instanceId: fresh,
        provider: 'ses',
        region: 'eu-central-1',
        smtpHost: 'email-smtp.eu-central-1.amazonaws.com',
        smtpPort: 587,
        smtpSecurity: 'starttls',
        smtpUsername: 'AKIAEXAMPLE',
        smtpPasswordEncrypted: ENCRYPTED,
        mailFrom: 'LobbyForge <no-reply@example.org>',
      });
      expect(created).toMatchObject({ provider: 'ses', smtpPort: 587, smtpSecurity: 'starttls', verificationMode: 'off' });

      const updated = await setInstanceMailSettings(db, {
        instanceId: fresh,
        verificationMode: 'optional',
        verificationScope: { open_register: true, invite_register: true },
        disposableBlock: true,
        disposableOverrides: { allow: ['ok.example'], block: ['bad.example'] },
        dailyLimit: 500,
      });
      expect(updated).toMatchObject({
        provider: 'ses',
        smtpHost: 'email-smtp.eu-central-1.amazonaws.com',
        smtpPasswordEncrypted: ENCRYPTED,
        verificationMode: 'optional',
        verificationScope: { open_register: true, invite_register: true },
        disposableBlock: true,
        disposableOverrides: { allow: ['ok.example'], block: ['bad.example'] },
        dailyLimit: 500,
      });

      const at = new Date('2026-10-04T10:00:00Z');
      const fingerprint = 'ab'.repeat(32);
      await recordInstanceMailTest(db, { instanceId: fresh, result: 'ok', fingerprint, at });
      const tested = await getInstanceMailSettings(db, fresh);
      expect(tested.lastTestAt!.toISOString()).toBe(at.toISOString());
      expect(tested.lastTestResult).toBe('ok');
      expect(tested.lastTestFingerprint).toBe(fingerprint);
      expect(tested.updatedAt!.toISOString()).toBe(updated.updatedAt!.toISOString());

      const cleared = await setInstanceMailSettings(db, { instanceId: fresh, smtpPasswordEncrypted: null, smtpUsername: null });
      expect(cleared).toMatchObject({ smtpPasswordEncrypted: null, smtpUsername: null, provider: 'ses' });
    });

    it('sets enforced_since once and never moves it', async () => {
      const id = `mail-enforced-${run}`;
      instanceIds.push(id);
      await sql`INSERT INTO instance_settings (instance_id, instance_name) VALUES (${id}, 'Enforced')`;
      const first = await ensureEmailVerificationEnforcedSince(db, { instanceId: id, now: new Date('2026-10-01T00:00:00Z') });
      expect(first!.toISOString()).toBe('2026-10-01T00:00:00.000Z');
      const again = await ensureEmailVerificationEnforcedSince(db, { instanceId: id, now: new Date('2026-10-05T00:00:00Z') });
      expect(again!.toISOString()).toBe('2026-10-01T00:00:00.000Z');
      expect(await ensureEmailVerificationEnforcedSince(db, { instanceId: `mail-none-${run}` })).toBeNull();
    });

    it('refuses a plaintext password, an unknown mode or security, a bad port and non-object JSON', async () => {
      const id = `mail-checks-${run}`;
      instanceIds.push(id);
      await sql`INSERT INTO instance_settings (instance_id, instance_name) VALUES (${id}, 'Checks')`;
      const bad: Array<[postgres.PendingQuery<postgres.Row[]>, RegExp]> = [
        [sql`UPDATE instance_settings SET smtp_password_encrypted = 'hunter2' WHERE instance_id = ${id}`, /smtp_password_encrypted_check/],
        [sql`UPDATE instance_settings SET email_verification_mode = 'strict' WHERE instance_id = ${id}`, /email_verification_mode_check/],
        [sql`UPDATE instance_settings SET smtp_security = 'ssl' WHERE instance_id = ${id}`, /smtp_security_check/],
        [sql`UPDATE instance_settings SET smtp_port = 70000 WHERE instance_id = ${id}`, /smtp_port_check/],
        [sql`UPDATE instance_settings SET mail_provider = 'Not A Slug' WHERE instance_id = ${id}`, /mail_provider_check/],
        [sql`UPDATE instance_settings SET email_verification_scope = '[]'::jsonb WHERE instance_id = ${id}`, /email_verification_scope_check/],
        [sql`UPDATE instance_settings SET disposable_email_overrides = '"x"'::jsonb WHERE instance_id = ${id}`, /disposable_email_overrides_check/],
        [sql`UPDATE instance_settings SET mail_daily_limit = 0 WHERE instance_id = ${id}`, /mail_daily_limit_check/],
        [sql`UPDATE instance_settings SET mail_last_test_fingerprint = 'not-hex' WHERE instance_id = ${id}`, /mail_last_test_fingerprint_check/],
      ];
      for (const [query, constraint] of bad) await expect(query).rejects.toThrow(constraint);
    });
  });

  describe('challenges', () => {
    it('a new send replaces the live challenge; the index keeps one live row per user and purpose', async () => {
      const user = await createUser();
      const first = await newToken(user.id, 'verify', user.email!);
      const second = await newToken(user.id, 'verify', user.email!);
      expect((await getActiveEmailToken(db, user.id, 'verify'))!.id).toBe(second.row.id);
      expect(await getEmailTokenByHash(db, first.tokenHash)).toBeNull();
      // Another purpose lives alongside.
      await newToken(user.id, 'reset', user.email!);
      expect(await getActiveEmailToken(db, user.id, 'reset')).not.toBeNull();
      // A second live row inserted behind the query helper's back is refused.
      await expect(sql`
        INSERT INTO email_tokens (user_id, purpose, target_email, token_hash, code_hash, expires_at, code_expires_at)
        VALUES (${user.id}, 'verify', ${user.email!}, ${randomBytes(32)}, ${randomBytes(32)}, now() + interval '1 hour', now() + interval '1 hour')`).rejects.toThrow(
        /email_tokens_user_purpose_active_unique/
      );
      // Concurrent sends serialize on the advisory lock: all succeed, one stays live.
      await Promise.all(Array.from({ length: 6 }, () => newToken(user.id, 'verify', user.email!)));
      const [{ live }] = await sql<{ live: number }[]>`
        SELECT count(*)::int AS live FROM email_tokens WHERE user_id = ${user.id} AND purpose = 'verify' AND consumed_at IS NULL`;
      expect(live).toBe(1);
    });

    it('refuses a raw token or code in the hash columns', async () => {
      const user = await createUser();
      await expect(sql`
        INSERT INTO email_tokens (user_id, purpose, target_email, token_hash, code_hash, expires_at, code_expires_at)
        VALUES (${user.id}, 'verify', ${user.email!}, ${Buffer.from('123456')}, ${randomBytes(32)}, now(), now())`).rejects.toThrow(
        /email_tokens_token_hash_check/
      );
      await expect(sql`
        INSERT INTO email_tokens (user_id, purpose, target_email, token_hash, code_hash, expires_at, code_expires_at)
        VALUES (${user.id}, 'login', ${user.email!}, ${randomBytes(32)}, ${randomBytes(32)}, now(), now())`).rejects.toThrow(/email_tokens_purpose_check/);
    });

    it('of many concurrent submissions of one challenge exactly one wins', async () => {
      const user = await createUser();
      const { row } = await newToken(user.id, 'verify', user.email!);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          applyEmailVerification(db, i % 2 ? { kind: 'link', tokenId: row.id } : { kind: 'code', tokenId: row.id, maxAttempts: 5 })
        )
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'gone')).toBe(true);
      expect((await getUserEmailState(db, user.id))!.emailVerifiedAt).toBeInstanceOf(Date);
      expect(await getActiveEmailToken(db, user.id, 'verify')).toBeNull();
    });

    it('attempts are reserved before any comparison: 12 concurrent guesses get exactly 5', async () => {
      const user = await createUser();
      const { row } = await newToken(user.id, 'verify', user.email!);
      const reserved = await Promise.all(Array.from({ length: 12 }, () => reserveEmailCodeAttempt(db, row.id, 5)));
      const granted = reserved.filter((r): r is NonNullable<typeof r> => r !== null);
      expect(granted).toHaveLength(5);
      expect(granted.map((r) => r.codeAttempts).sort()).toEqual([1, 2, 3, 4, 5]);
      expect(await reserveEmailCodeAttempt(db, row.id, 5)).toBeNull();
      const [{ code_attempts }] = await sql<{ code_attempts: number }[]>`SELECT code_attempts FROM email_tokens WHERE id = ${row.id}`;
      expect(code_attempts).toBe(5);
      // The link is not bound by the code's attempts.
      expect((await applyEmailVerification(db, { kind: 'link', tokenId: row.id })).ok).toBe(true);
      expect(await reserveEmailCodeAttempt(db, row.id, 5)).toBeNull();
    });

    it('no attempt is reserved on an expired code or a consumed challenge; the reserved one can consume at the cap', async () => {
      const user = await createUser();
      const expired = await newToken(user.id, 'verify', user.email!, { codeMs: -1_000 });
      expect(await reserveEmailCodeAttempt(db, expired.row.id, 5)).toBeNull();
      const live = await newToken(user.id, 'reset', user.email!);
      for (let i = 0; i < 4; i += 1) expect(await reserveEmailCodeAttempt(db, live.row.id, 5)).not.toBeNull();
      // The fifth (last) attempt is reserved, then consumes.
      expect((await reserveEmailCodeAttempt(db, live.row.id, 5))!.codeAttempts).toBe(5);
      expect((await applyPasswordReset(db, { kind: 'code', tokenId: live.row.id, maxAttempts: 5 }, 'scrypt$last')).ok).toBe(true);
      expect(await reserveEmailCodeAttempt(db, live.row.id, 5)).toBeNull();
    });

    it('the code keeps its own window; the link keeps its longer one', async () => {
      const user = await createUser();

      const expiredCode = await newToken(user.id, 'reset', user.email!, { codeMs: -1_000 });
      expect(await applyPasswordReset(db, { kind: 'code', tokenId: expiredCode.row.id, maxAttempts: 5 }, 'scrypt$new')).toEqual({
        ok: false,
        reason: 'gone',
      });
      expect((await applyPasswordReset(db, { kind: 'link', tokenId: expiredCode.row.id }, 'scrypt$new')).ok).toBe(true);

      const expiredLink = await newToken(user.id, 'reset', user.email!, { linkMs: -1_000, codeMs: 60_000 });
      expect(await applyPasswordReset(db, { kind: 'link', tokenId: expiredLink.row.id }, 'scrypt$x')).toEqual({ ok: false, reason: 'gone' });
      expect(await applyPasswordReset(db, { kind: 'code', tokenId: expiredLink.row.id, maxAttempts: 5 }, 'scrypt$x')).toEqual({
        ok: false,
        reason: 'gone',
      });
    });

    it('a challenge of another purpose cannot be spent here', async () => {
      const user = await createUser();
      const { row } = await newToken(user.id, 'reset', user.email!);
      expect(await applyEmailVerification(db, { kind: 'link', tokenId: row.id })).toEqual({ ok: false, reason: 'gone' });
      expect(await applyEmailChange(db, { kind: 'link', tokenId: row.id })).toEqual({ ok: false, reason: 'gone' });
      expect(await getActiveEmailToken(db, user.id, 'reset')).not.toBeNull();
    });

    it('a verification for an address the account no longer has verifies nothing', async () => {
      const user = await createUser();
      const { row } = await newToken(user.id, 'verify', user.email!);
      await sql`UPDATE users SET email = ${`moved-${randomUUID()}@example.test`} WHERE id = ${user.id}`;
      expect(await applyEmailVerification(db, { kind: 'link', tokenId: row.id })).toEqual({ ok: false, reason: 'email_mismatch' });
      expect((await getUserEmailState(db, user.id))!.emailVerifiedAt).toBeNull();
    });
  });

  describe('change and reset', () => {
    it('applies a change only while the address is free; the change verifies the new address', async () => {
      const user = await createUser();
      const target = `new-${randomUUID()}@example.test`;
      const { row } = await newToken(user.id, 'change', target);
      const squatter = await createUser({ email: target });
      expect(await applyEmailChange(db, { kind: 'link', tokenId: row.id })).toEqual({ ok: false, reason: 'email_taken' });
      // Not consumed: nothing was applied.
      expect((await getActiveEmailToken(db, user.id, 'change'))!.id).toBe(row.id);

      await sql`DELETE FROM users WHERE id = ${squatter.id}`;
      const applied = await applyEmailChange(db, { kind: 'code', tokenId: row.id, maxAttempts: 5 });
      expect(applied).toEqual({ ok: true, userId: user.id, oldEmail: user.email, newEmail: target });
      const state = await getUserEmailState(db, user.id);
      expect(state!.email).toBe(target);
      expect(state!.emailVerifiedAt).toBeInstanceOf(Date);
      expect((await getUserEmailStateByEmail(db, target))!.id).toBe(user.id);
    });

    it('two changes racing for one address: one wins, the other is email_taken', async () => {
      const a = await createUser();
      const b = await createUser();
      const target = `race-${randomUUID()}@example.test`;
      const ta = await newToken(a.id, 'change', target);
      const tb = await newToken(b.id, 'change', target);
      const results = await Promise.all([
        applyEmailChange(db, { kind: 'link', tokenId: ta.row.id }),
        applyEmailChange(db, { kind: 'link', tokenId: tb.row.id }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: 'email_taken' });
    });

    it('a reset sets the password and verifies the address', async () => {
      const user = await createUser();
      const { row } = await newToken(user.id, 'reset', user.email!);
      const result = await applyPasswordReset(db, { kind: 'link', tokenId: row.id }, 'scrypt$reset');
      expect(result).toEqual({ ok: true, userId: user.id, email: user.email, emailVerified: true });
      const [{ password_hash }] = await sql<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE id = ${user.id}`;
      expect(password_hash).toBe('scrypt$reset');
      expect(await applyPasswordReset(db, { kind: 'link', tokenId: row.id }, 'scrypt$again')).toEqual({ ok: false, reason: 'gone' });
    });

    it('a reset for a deleted account changes nothing and leaves the challenge live', async () => {
      const user = await createUser();
      const { row } = await newToken(user.id, 'reset', user.email!);
      await sql`UPDATE users SET deleted_at = now() WHERE id = ${user.id}`;
      expect(await applyPasswordReset(db, { kind: 'link', tokenId: row.id }, 'scrypt$nope')).toEqual({ ok: false, reason: 'user_gone' });
      expect(await getActiveEmailToken(db, user.id, 'reset')).not.toBeNull();
    });
  });

  describe('password and address writes drop stale challenges', () => {
    it('BLOCKER: a pending email change does not survive a password reset', async () => {
      const user = await createUser();
      const change = await newToken(user.id, 'change', `attacker-${randomUUID()}@example.test`);
      const reset = await newToken(user.id, 'reset', user.email!);
      expect((await applyPasswordReset(db, { kind: 'link', tokenId: reset.row.id }, 'scrypt$victim')).ok).toBe(true);
      expect(await getActiveEmailToken(db, user.id, 'change')).toBeNull();
      expect(await getEmailTokenByHash(db, change.tokenHash)).toBeNull();
      expect(await applyEmailChange(db, { kind: 'link', tokenId: change.row.id })).toEqual({ ok: false, reason: 'gone' });
      expect((await getUserEmailState(db, user.id))!.email).toBe(user.email);
    });

    it('BLOCKER: nor a password change from the settings', async () => {
      const user = await createUser();
      await newToken(user.id, 'change', `attacker-${randomUUID()}@example.test`);
      await newToken(user.id, 'reset', user.email!);
      const verify = await newToken(user.id, 'verify', user.email!);
      expect(await replaceUserPasswordHash(db, { userId: user.id, currentPasswordHash: 'scrypt$wrong', newPasswordHash: 'scrypt$x' })).toBe(false);
      expect(await getActiveEmailToken(db, user.id, 'change')).not.toBeNull();
      expect(await replaceUserPasswordHash(db, { userId: user.id, currentPasswordHash: 'scrypt$old', newPasswordHash: 'scrypt$new' })).toBe(true);
      expect(await getActiveEmailToken(db, user.id, 'change')).toBeNull();
      expect(await getActiveEmailToken(db, user.id, 'reset')).toBeNull();
      // A verification is not about the password: it stays.
      expect((await getActiveEmailToken(db, user.id, 'verify'))!.id).toBe(verify.row.id);
    });

    it('a reset token only works for the address it was sent to', async () => {
      const user = await createUser();
      const reset = await newToken(user.id, 'reset', user.email!);
      await sql`UPDATE users SET email = ${`moved-${randomUUID()}@example.test`} WHERE id = ${user.id}`;
      expect(await applyPasswordReset(db, { kind: 'link', tokenId: reset.row.id }, 'scrypt$nope')).toEqual({ ok: false, reason: 'email_mismatch' });
      const [{ password_hash }] = await sql<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE id = ${user.id}`;
      expect(password_hash).toBe('scrypt$old');
    });

    it('an email change drops the reset and verify challenges sent to the old address', async () => {
      const user = await createUser();
      const reset = await newToken(user.id, 'reset', user.email!);
      const verify = await newToken(user.id, 'verify', user.email!);
      const change = await newToken(user.id, 'change', `new-${randomUUID()}@example.test`);
      expect((await applyEmailChange(db, { kind: 'link', tokenId: change.row.id })).ok).toBe(true);
      expect(await getEmailTokenByHash(db, reset.tokenHash)).toBeNull();
      expect(await getEmailTokenByHash(db, verify.tokenHash)).toBeNull();
      // And a direct change drops everything live.
      const again = await newToken(user.id, 'reset', (await getUserEmailState(db, user.id))!.email!);
      const pending = await newToken(user.id, 'change', `other-${randomUUID()}@example.test`);
      expect(await changeUserEmailDirect(db, user.id, `direct-${randomUUID()}@example.test`)).toEqual({ ok: true });
      expect(await getEmailTokenByHash(db, again.tokenHash)).toBeNull();
      expect(await getEmailTokenByHash(db, pending.tokenHash)).toBeNull();
    });

    it('revokeEmailChallenges drops only the purposes asked for', async () => {
      const user = await createUser();
      await newToken(user.id, 'change', `x-${randomUUID()}@example.test`);
      await newToken(user.id, 'verify', user.email!);
      await revokeEmailChallenges(db, user.id, ['change']);
      expect(await getActiveEmailToken(db, user.id, 'change')).toBeNull();
      expect(await getActiveEmailToken(db, user.id, 'verify')).not.toBeNull();
    });
  });

  describe('signup channel', () => {
    it('is stored at creation and refuses unknown values', async () => {
      const server = await sql<{ id: string }[]>`
        INSERT INTO servers (name, owner_user_id) VALUES ('Channel test', ${(await createUser()).id}) RETURNING id`;
      const serverId = server[0]!.id;
      await sql`INSERT INTO roles (server_id, name, position, permissions) VALUES (${serverId}, '@everyone', 0, '[]'::jsonb)`;
      const open = await createLocalAccount(db, { email: `open-${randomUUID()}@example.test`, displayName: 'Open', passwordHash: 'scrypt$x', serverId });
      expect(open.ok).toBe(true);
      if (!open.ok) return;
      userIds.push(open.user.id);
      expect((await getUserEmailState(db, open.user.id))!.signupChannel).toBe('open');
      const guest = await findOrCreateGuestUser(db, { guestKey: `google:${randomUUID()}`, displayName: 'G', signupChannel: 'oauth' });
      userIds.push(guest!.id);
      expect((await getUserEmailState(db, guest!.id))!.signupChannel).toBe('oauth');
      const legacy = await createUser();
      expect((await getUserEmailState(db, legacy.id))!.signupChannel).toBeNull();
      await expect(sql`UPDATE users SET signup_channel = 'magic' WHERE id = ${legacy.id}`).rejects.toThrow(/users_signup_channel_check/);
      await sql`DELETE FROM servers WHERE id = ${serverId}`;
    });

    it('marks an account verified for a third-party address only when it is the account address', async () => {
      const user = await createUser();
      expect(await markUserEmailVerifiedForAddress(db, user.id, 'someone-else@example.test')).toBe(false);
      expect((await getUserEmailState(db, user.id))!.emailVerifiedAt).toBeNull();
      expect(await markUserEmailVerifiedForAddress(db, user.id, user.email!.toUpperCase())).toBe(true);
      expect((await getUserEmailState(db, user.id))!.emailVerifiedAt).toBeInstanceOf(Date);
      const guest = await createUser({ email: null, guest: true });
      expect(await markUserEmailVerifiedForAddress(db, guest.id, 'g@example.test')).toBe(false);
    });
  });

  describe('account helpers', () => {
    it('direct change clears verification and refuses a taken address; admin verify keeps an earlier time', async () => {
      const user = await createUser({ verified: true });
      const other = await createUser();
      expect(await changeUserEmailDirect(db, user.id, other.email!)).toEqual({ ok: false, reason: 'email_taken' });
      const next = `direct-${randomUUID()}@example.test`;
      expect(await changeUserEmailDirect(db, user.id, next)).toEqual({ ok: true });
      const state = await getUserEmailState(db, user.id);
      expect(state).toMatchObject({ email: next, emailVerifiedAt: null, hasPassword: true, isGuest: false, signupChannel: null });

      expect(await markUserEmailVerified(db, user.id)).toBe(true);
      const first = (await getUserEmailState(db, user.id))!.emailVerifiedAt!;
      expect(await markUserEmailVerified(db, user.id)).toBe(true);
      expect((await getUserEmailState(db, user.id))!.emailVerifiedAt!.toISOString()).toBe(first.toISOString());
      expect(await markUserEmailVerified(db, randomUUID())).toBe(false);
    });

    it('lists verification states without addresses', async () => {
      const verified = await createUser({ verified: true });
      const guest = await createUser({ email: null, guest: true });
      const rows = await listUserEmailVerification(db, [verified.id, guest.id]);
      const byId = new Map(rows.map((row) => [row.userId, row]));
      expect(byId.get(verified.id)).toMatchObject({ hasEmail: true, isGuest: false });
      expect(byId.get(verified.id)!.emailVerifiedAt).toBeInstanceOf(Date);
      expect(byId.get(guest.id)).toEqual({ userId: guest.id, hasEmail: false, isGuest: true, emailVerifiedAt: null });
      expect(Object.keys(rows[0]!)).not.toContain('email');
      expect(await listUserEmailVerification(db, [])).toEqual([]);
    });

    it('housekeeping drops stale challenges; deleting the user drops theirs', async () => {
      const user = await createUser();
      const { row } = await newToken(user.id, 'verify', user.email!, { linkMs: -2 * HOUR, codeMs: -2 * HOUR });
      const live = await newToken(user.id, 'reset', user.email!);
      expect(await deleteStaleEmailTokens(db, new Date(Date.now() - HOUR))).toBeGreaterThanOrEqual(1);
      expect(await getEmailTokenByHash(db, live.tokenHash)).not.toBeNull();
      const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM email_tokens WHERE id = ${row.id}`;
      expect(count).toBe(0);
      await sql`DELETE FROM users WHERE id = ${user.id}`;
      expect(await getEmailTokenByHash(db, live.tokenHash)).toBeNull();
    });
  });
});
