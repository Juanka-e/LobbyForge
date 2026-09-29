/**
 * Migration smoke test: just verify the script loads and parses without
 * throwing. We don't connect to a DB — that would require a live
 * postgres. The runtime path is exercised by `pnpm -F @lobbyforge/db db:migrate`
 * against the dev DSN in CI.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('db:migrate', () => {
  it('the migrate.js bundle includes the migrator + the dev DSN fallback', () => {
    const file = readFileSync(join(__dirname, '..', '..', 'dist', 'migrate.js'), 'utf8');
    expect(file).toMatch(/drizzle-orm\/postgres-js\/migrator/);
    expect(file).toMatch(/lobbyforge:lobbyforge_dev@localhost:19532\/lobbyforge/);
  });

  it('tracks every SQL migration in journal order and has a current snapshot', () => {
    const drizzleDir = join(__dirname, '..', '..', 'drizzle');
    const journal = JSON.parse(
      readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')
    ) as { entries: Array<{ idx: number; tag: string }> };
    const sqlTags = readdirSync(drizzleDir)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .map((name) => name.replace(/\.sql$/, ''))
      .sort();
    const journalTags = journal.entries
      .sort((a, b) => a.idx - b.idx)
      .map((entry) => entry.tag);

    expect(journalTags).toEqual(sqlTags);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index)
    );

    const latest = journal.entries.at(-1);
    expect(latest).toBeDefined();
    // Derive the snapshot filename from the TAG prefix (e.g. "0025_game_session_revision"
    // → "0025_snapshot.json"), not from idx — they can diverge legitimately.
    const latestPrefix = latest!.tag.slice(0, 4);
    expect(
      readdirSync(join(drizzleDir, 'meta')).includes(
        `${latestPrefix}_snapshot.json`
      )
    ).toBe(true);
  });

  it('ships a one-way bootstrap lock with a guarded legacy backfill', () => {
    const sql = readFileSync(
      join(__dirname, '..', '..', 'drizzle', '0013_irreversible_bootstrap_lock.sql'),
      'utf8'
    );
    expect(sql).toContain('"bootstrap_version" integer DEFAULT 1 NOT NULL');
    expect(sql).toContain('SET "bootstrap_version" = 2');
    expect(sql).toContain('u."password_hash" IS NOT NULL');
    expect(sql).toContain('s."deleted_at" IS NULL');
  });

  it('adds the bots runtime additively (0037)', () => {
    const sql = readFileSync(
      join(__dirname, '..', '..', 'drizzle', '0037_bots_runtime.sql'),
      'utf8'
    );
    // Expand-only: no table is created, dropped or rewritten, no column removed.
    expect(sql).not.toMatch(/CREATE TABLE|DROP TABLE|DROP COLUMN|ALTER COLUMN "[a-z_]+" TYPE/);
    expect(sql).toContain('ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "bot_id" uuid');
    expect(sql).toContain('REFERENCES "bots"("id") ON DELETE set null');
    expect(sql).toContain('"bots_server_builtin_type_unique"');
    expect(sql).toMatch(/WHERE "type" IN \('welcome', 'moderation'\)/);
    // Tokens stay hashes: there is no column that could hold a raw token.
    expect(sql).not.toMatch(/ADD COLUMN[^;]*"token"\s/);
    expect(sql).toContain(`ALTER COLUMN "permissions" SET DEFAULT '[]'::jsonb`);
    // Every statement is separated for the migrator.
    const statements = sql
      .split('--> statement-breakpoint')
      .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    expect(statements.every((statement) => statement.split(';').filter((s) => s.trim()).length === 1)).toBe(true);
  });

  it('gives role-less members @everyone and touches nothing else (0038)', () => {
    const sql = readFileSync(
      join(__dirname, '..', '..', 'drizzle', '0038_backfill_everyone_role.sql'),
      'utf8'
    );
    // Data only: one INSERT, no schema change, no update or delete.
    expect(sql).not.toMatch(/CREATE|DROP|ALTER|UPDATE|DELETE/);
    expect(sql.match(/INSERT INTO "membership_roles"/g)).toHaveLength(1);
    // Only members with no display role AND no role rows; idempotent.
    expect(sql).toContain('m."role_id" IS NULL');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "membership_roles"');
    expect(sql).toContain(`WHERE "name" = '@everyone'`);
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    // A moderator's deliberate lock-out (roles set to none) is not undone.
    expect(sql).toContain(`a."action" = 'member.set_roles'`);
    // One role per server even if someone named another role @everyone.
    expect(sql).toContain('DISTINCT ON ("server_id")');
  });

  it('adds identity links without recreating previously migrated tables', () => {
    const sql = readFileSync(
      join(__dirname, '..', '..', 'drizzle', '0018_user_identity_links.sql'),
      'utf8'
    );
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql).toContain('CREATE TABLE "user_identity_links"');
    expect(sql).toContain('user_identity_links_provider_subject_unique');
    expect(sql).toContain('user_identity_links_user_provider_unique');
    expect(sql).not.toContain('CREATE TABLE "user_blocks"');
    expect(sql).not.toContain('CREATE TABLE "server_voice_settings"');
  });
});
