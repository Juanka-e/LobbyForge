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

  it('keeps moderation state outside the membership, additively (0040, security-review AUTHZ-002)', () => {
    const sql = readFileSync(
      join(__dirname, '..', '..', 'drizzle', '0040_server_member_sanctions.sql'),
      'utf8'
    );
    // Expand-only: one new table, nothing dropped, altered or deleted.
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "server_member_sanctions"');
    expect(sql).not.toMatch(/DROP |ALTER TABLE|DELETE FROM|^UPDATE /m);
    expect(sql).toContain('PRIMARY KEY ("server_id", "user_id")');
    // Outlives the membership: keyed to servers/users, never to memberships.
    expect(sql).not.toMatch(/REFERENCES "memberships"/);
    expect(sql).toContain('REFERENCES "servers"("id") ON DELETE cascade');
    expect(sql).toContain('REFERENCES "users"("id") ON DELETE cascade');
    // Backfill of the sanctions in force today; idempotent.
    expect(sql).toMatch(/INSERT INTO "server_member_sanctions"[\s\S]*FROM "memberships" m/);
    expect(sql).toContain('m."timed_out_until" IS NOT NULL OR m."voice_muted" = true');
    expect(sql).toContain('ON CONFLICT ("server_id", "user_id") DO NOTHING');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    expect(statements.every((statement) => statement.split(';').filter((s) => s.trim()).length === 1)).toBe(true);
  });

  it('adds explicit user image versions, additively and idempotently (0041, security-review FILE-001)', () => {
    const drizzleDir = join(__dirname, '..', '..', 'drizzle');
    const sql = readFileSync(join(drizzleDir, '0041_user_image_versions.sql'), 'utf8');
    // Expand-only: two new columns, nothing created, dropped, rewritten or backfilled.
    expect(sql).not.toMatch(/CREATE |DROP |DELETE FROM|^UPDATE |ALTER COLUMN/m);
    expect(sql).toContain('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_version" integer DEFAULT 0 NOT NULL');
    expect(sql).toContain('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "banner_version" integer DEFAULT 0 NOT NULL');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    expect(statements.every((statement) => statement.split(';').filter((s) => s.trim()).length === 1)).toBe(true);

    // The snapshot chains from 0040 and records both columns on users.
    const prev = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0040_snapshot.json'), 'utf8')) as { id: string };
    const snapshot = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0041_snapshot.json'), 'utf8')) as {
      id: string;
      prevId: string;
      tables: Record<string, { columns: Record<string, { type: string; notNull: boolean; default?: unknown }> }>;
    };
    expect(snapshot.prevId).toBe(prev.id);
    expect(snapshot.id).not.toBe(prev.id);
    for (const column of ['avatar_version', 'banner_version']) {
      expect(snapshot.tables['public.users']!.columns[column]).toMatchObject({ type: 'integer', notNull: true, default: 0 });
    }
  });

  it('purges only gameplay audit rows, with no schema change (0042, security-review PLUG-001)', () => {
    const drizzleDir = join(__dirname, '..', '..', 'drizzle');
    const sql = readFileSync(join(drizzleDir, '0042_purge_gameplay_audit_rows.sql'), 'utf8');
    const body = sql.replace(/^\s*--.*$/gm, '').trim();
    // One statement, data-only, scoped to activity.action rows.
    expect(body).not.toMatch(/CREATE |DROP |ALTER |UPDATE /);
    expect(body.split(';').filter((s) => s.trim())).toHaveLength(1);
    expect(body).toMatch(/^DELETE FROM "audit_logs"\s+WHERE "action" = 'activity\.action'/);
    // The privacy-relevant rows go; host actions are never named.
    for (const gameplay of ["'night-target'", "'pack-chat'", "'night-shield'"]) expect(body).toContain(gameplay);
    expect(body).toContain(`"metadata"->>'pluginId' = 'poll' AND "metadata"->>'actionType' IN ('vote')`);
    for (const host of ["'start'", "'kick'", "'configure'", "'close-poll'", "'open-poll'"]) expect(body).not.toContain(host);
    // Only the plugins whose rows leaked secrets; old Watch Party rows
    // include former host actions and stay.
    for (const kept of ["'watch-party'", "'quiz'", "'dice-bot'", "'hushle'"]) expect(body).not.toContain(kept);

    // Snapshot chains from 0041 and is otherwise unchanged.
    const prev = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0041_snapshot.json'), 'utf8')) as Record<string, unknown>;
    const snapshot = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0042_snapshot.json'), 'utf8')) as Record<string, unknown>;
    expect(snapshot.prevId).toBe(prev.id);
    expect(snapshot.id).not.toBe(prev.id);
    expect({ ...snapshot, id: null, prevId: null }).toEqual({ ...prev, id: null, prevId: null });
  });

  it('adds the join approval queue additively, one pending request per user (0043)', () => {
    const drizzleDir = join(__dirname, '..', '..', 'drizzle');
    const sql = readFileSync(join(drizzleDir, '0043_server_join_requests.sql'), 'utf8');
    // Expand-only: one new table; the only ALTER is a column default.
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "server_join_requests"');
    expect(sql).not.toMatch(/DROP |DELETE FROM|^UPDATE |ALTER COLUMN "[a-z_]+" TYPE/m);
    expect(sql).toContain(`ALTER TABLE "server_access_policies" ALTER COLUMN "join_policy" SET DEFAULT 'public_self_register'`);
    expect(sql).toContain('REFERENCES "servers"("id") ON DELETE cascade');
    expect(sql).toContain('"decided_by") REFERENCES "users"("id") ON DELETE set null');
    // The partial unique index (SQL-only, like game_sessions_channel_open_unique).
    expect(sql).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS "server_join_requests_one_pending_unique" ON "server_join_requests" USING btree ("server_id","user_id") WHERE "status" = 'pending'`
    );
    expect(sql).toContain(`CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled'))`);
    expect(sql).toContain(`CHECK ("note" IS NULL OR char_length("note") <= 500)`);
    const statements = sql
      .split('--> statement-breakpoint')
      .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    expect(statements).toHaveLength(5);
    expect(statements.every((statement) => statement.split(';').filter((s) => s.trim()).length === 1)).toBe(true);

    // The snapshot chains from 0042, adds the table and the new default.
    const prev = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0042_snapshot.json'), 'utf8')) as { id: string };
    const snapshot = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0043_snapshot.json'), 'utf8')) as {
      id: string;
      prevId: string;
      tables: Record<string, { columns: Record<string, { default?: unknown }> }>;
    };
    expect(snapshot.prevId).toBe(prev.id);
    expect(snapshot.id).not.toBe(prev.id);
    expect(Object.keys(snapshot.tables['public.server_join_requests']!.columns)).toEqual([
      'id', 'server_id', 'user_id', 'source', 'invite_code', 'note', 'status', 'created_at', 'decided_at', 'decided_by',
      'rejected_by_ban',
    ]);
    // A rejection written by a ban is flagged so it starts no cooldown.
    expect(sql).toContain('"rejected_by_ban" boolean DEFAULT false NOT NULL');
    expect(snapshot.tables['public.server_join_requests']!.columns.rejected_by_ban).toMatchObject({
      type: 'boolean',
      notNull: true,
      default: false,
    });
    expect(snapshot.tables['public.server_access_policies']!.columns.join_policy!.default).toBe("'public_self_register'");
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
