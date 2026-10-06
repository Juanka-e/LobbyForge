/**
 * 0046_email — the migration file, journal and snapshot, read from disk
 * (no database). The SQL itself (and its backfill) runs in
 * email.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emailTokens, instanceSettings, users } from '../schema.js';
import { DEFAULT_DISPOSABLE_EMAIL_OVERRIDES, DEFAULT_EMAIL_VERIFICATION_SCOPE } from '../queries/instanceSettings.js';

const drizzleDir = join(__dirname, '..', '..', 'drizzle');
const sql = readFileSync(join(drizzleDir, '0046_email.sql'), 'utf8');
const SETTINGS_COLUMNS = [
  'mail_provider',
  'mail_region',
  'smtp_host',
  'smtp_port',
  'smtp_security',
  'smtp_username',
  'smtp_password_encrypted',
  'mail_from',
  'mail_daily_limit',
  'mail_last_test_at',
  'mail_last_test_result',
  'mail_last_test_fingerprint',
  'email_verification_mode',
  'email_verification_scope',
  'email_verification_enforced_since',
  'email_verification_existing_deadline',
  'disposable_email_block',
  'disposable_email_overrides',
];
const USERS_COLUMNS = ['email_verified_at', 'signup_channel'];

function statements(): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

describe('0046_email', () => {
  it('is expand-only and idempotent', () => {
    expect(sql.match(/ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS/g)).toHaveLength(SETTINGS_COLUMNS.length);
    for (const column of SETTINGS_COLUMNS) {
      expect(sql).toContain(`ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "${column}"`);
    }
    expect(sql.match(/ALTER TABLE "users" ADD COLUMN IF NOT EXISTS/g)).toHaveLength(USERS_COLUMNS.length);
    expect(sql).toContain('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamp with time zone;');
    expect(sql).toContain('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "signup_channel" text');
    expect(sql.match(/CREATE TABLE IF NOT EXISTS "email_tokens"/g)).toHaveLength(1);
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql).not.toMatch(/DROP |DELETE FROM|ALTER COLUMN|RENAME|TRUNCATE/);
    // The only UPDATE is the backfill, and it only touches rows still NULL.
    expect(sql.match(/^UPDATE /gm)).toHaveLength(1);
    expect(sql).toMatch(/UPDATE "users" SET "email_verified_at" = now\(\)\s+WHERE "email_verified_at" IS NULL/);
  });

  it('backfills only accounts whose verified Google address is the account address', () => {
    const backfill = statements().find((s) => s.startsWith('UPDATE'))!;
    expect(backfill).toContain('"l"."provider" = \'google\'');
    expect(backfill).toContain('"l"."email_verified" = true');
    expect(backfill).toContain('"l"."user_id" = "users"."id"');
    expect(backfill).toContain('lower("l"."provider_email") = "users"."email"');
    expect(backfill).toContain('"email" IS NOT NULL');
  });

  it('starts with no transport and verification off', () => {
    expect(sql).toContain(`"mail_provider" text DEFAULT 'none' NOT NULL`);
    expect(sql).toContain(`"email_verification_mode" text DEFAULT 'off' NOT NULL`);
    expect(sql).toContain('"disposable_email_block" boolean DEFAULT false NOT NULL');
    const scope = /"email_verification_scope" jsonb DEFAULT '([^']+)'/.exec(sql)![1]!;
    expect(JSON.parse(scope)).toEqual(DEFAULT_EMAIL_VERIFICATION_SCOPE);
    const overrides = /"disposable_email_overrides" jsonb DEFAULT '([^']+)'/.exec(sql)![1]!;
    expect(JSON.parse(overrides)).toEqual(DEFAULT_DISPOSABLE_EMAIL_OVERRIDES);
  });

  it('keeps plaintext secrets and raw tokens out (CHECK backstops)', () => {
    expect(sql).toContain(
      `CHECK ("smtp_password_encrypted" IS NULL OR "smtp_password_encrypted" ~ '^v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$')`
    );
    expect(sql).toContain('CHECK (octet_length("token_hash") = 32)');
    expect(sql).toContain('CHECK (octet_length("code_hash") = 32)');
    expect(sql).toContain(`CHECK ("purpose" IN ('verify', 'change', 'reset'))`);
    expect(sql).toContain(`CHECK ("email_verification_mode" IN ('off', 'optional', 'required'))`);
    expect(sql).toContain(`CHECK ("smtp_security" IS NULL OR "smtp_security" IN ('tls', 'starttls', 'none'))`);
    expect(sql).toContain(`CHECK ("signup_channel" IS NULL OR "signup_channel" IN ('open', 'invite', 'oauth', 'setup'))`);
    expect(sql).toContain(`CHECK ("mail_last_test_fingerprint" IS NULL OR "mail_last_test_fingerprint" ~ '^[0-9a-f]{64}$')`);
    // A slug, not an enum: appending a provider to the registry needs no migration.
    expect(sql).toContain(`CHECK ("mail_provider" ~ '^[a-z0-9-]{1,32}$')`);
  });

  it('has one live challenge per user and purpose, and finds a challenge by its token hash', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "email_tokens_user_purpose_active_unique" ON "email_tokens" USING btree ("user_id","purpose") WHERE consumed_at IS NULL;'
    );
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "email_tokens_token_hash_unique" ON "email_tokens" USING btree ("token_hash");');
    expect(sql).toContain('FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade');
  });

  it('splits into single statements the migrator can run one by one', () => {
    const parts = statements();
    // The users columns + backfill + table + 2 indexes + the settings columns.
    expect(parts).toHaveLength(USERS_COLUMNS.length + 4 + SETTINGS_COLUMNS.length);
    expect(parts.every((statement) => statement.split(';').filter((s) => s.trim()).length === 1)).toBe(true);
  });

  it('matches the Drizzle schema', () => {
    expect(users.emailVerifiedAt.notNull).toBe(false);
    expect(users.signupChannel.notNull).toBe(false);
    expect(instanceSettings.mailProvider.default).toBe('none');
    expect(instanceSettings.mailProvider.notNull).toBe(true);
    expect(instanceSettings.mailLastTestFingerprint.notNull).toBe(false);
    expect(instanceSettings.emailVerificationMode.default).toBe('off');
    expect(instanceSettings.emailVerificationScope.default).toEqual(DEFAULT_EMAIL_VERIFICATION_SCOPE);
    expect(instanceSettings.disposableEmailOverrides.default).toEqual(DEFAULT_DISPOSABLE_EMAIL_OVERRIDES);
    expect(instanceSettings.disposableEmailBlock.default).toBe(false);
    expect(instanceSettings.smtpPasswordEncrypted.notNull).toBe(false);
    expect(emailTokens.codeAttempts.default).toBe(0);
    expect(emailTokens.consumedAt.notNull).toBe(false);
    expect(emailTokens.tokenHash.getSQLType()).toBe('bytea');
  });

  it('is journal entry 44 and its snapshot chains from 0045 with only the 0046 changes', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0046_email');
    expect(entry?.idx).toBe(44);
    const prevEntry = journal.entries.find((e) => e.tag === '0045_captcha');
    expect(entry!.when).toBeGreaterThan(prevEntry!.when);

    type Snapshot = {
      id: string;
      prevId: string;
      tables: Record<string, { columns: Record<string, { type: string; notNull: boolean; default?: unknown }>; indexes: Record<string, unknown> }>;
    };
    const prev = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0045_snapshot.json'), 'utf8')) as Snapshot;
    const snapshot = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0046_snapshot.json'), 'utf8')) as Snapshot;
    expect(snapshot.prevId).toBe(prev.id);
    expect(snapshot.id).not.toBe(prev.id);
    const changed = new Set(['public.instance_settings', 'public.users']);
    for (const [key, value] of Object.entries(prev.tables)) {
      if (changed.has(key)) continue;
      expect(snapshot.tables[key]).toEqual(value);
    }
    expect(Object.keys(snapshot.tables).filter((k) => !(k in prev.tables))).toEqual(['public.email_tokens']);

    const without = (table: Snapshot['tables'][string], drop: string[]) => ({
      ...table,
      columns: Object.fromEntries(Object.entries(table.columns).filter(([k]) => !drop.includes(k))),
    });
    expect(without(snapshot.tables['public.users']!, USERS_COLUMNS)).toEqual(prev.tables['public.users']);
    expect(snapshot.tables['public.users']!.columns.email_verified_at).toMatchObject({ type: 'timestamp with time zone', notNull: false });
    expect(snapshot.tables['public.users']!.columns.signup_channel).toMatchObject({ type: 'text', notNull: false });
    const after = snapshot.tables['public.instance_settings']!;
    expect(without(after, SETTINGS_COLUMNS)).toEqual(prev.tables['public.instance_settings']);
    expect(Object.keys(after.columns).filter((k) => SETTINGS_COLUMNS.includes(k))).toEqual(SETTINGS_COLUMNS);
    expect(after.columns.mail_provider).toMatchObject({ type: 'text', notNull: true, default: "'none'" });
    expect(after.columns.smtp_port).toMatchObject({ type: 'integer', notNull: false });
    expect(after.columns.mail_last_test_fingerprint).toMatchObject({ type: 'text', notNull: false });
    expect(after.columns.email_verification_mode).toMatchObject({ type: 'text', notNull: true, default: "'off'" });
    expect(after.columns.disposable_email_block).toMatchObject({ type: 'boolean', notNull: true, default: false });

    const tokens = snapshot.tables['public.email_tokens']!;
    expect(Object.keys(tokens.columns)).toEqual([
      'id',
      'user_id',
      'purpose',
      'target_email',
      'token_hash',
      'code_hash',
      'code_attempts',
      'expires_at',
      'code_expires_at',
      'consumed_at',
      'created_at',
    ]);
    expect(tokens.columns.token_hash).toMatchObject({ type: 'bytea', notNull: true });
    expect(tokens.indexes.email_tokens_user_purpose_active_unique).toMatchObject({ isUnique: true, where: 'consumed_at IS NULL' });
    expect(tokens.indexes.email_tokens_token_hash_unique).toMatchObject({ isUnique: true });
  });
});
