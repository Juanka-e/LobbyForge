/**
 * 0044_bot_api_v2 — the migration file, journal and snapshot, read from
 * disk (no database). The SQL itself runs in bot-api-v2.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const drizzleDir = join(__dirname, '..', '..', 'drizzle');
const sql = readFileSync(join(drizzleDir, '0044_bot_api_v2.sql'), 'utf8');
const TABLES = [
  'bot_channel_access',
  'bot_commands',
  'bot_command_overrides',
  'bot_interactions',
  'channel_webhooks',
  'bot_event_endpoints',
];

describe('0044_bot_api_v2', () => {
  it('is expand-only and idempotent: six new tables and one added column, nothing dropped or rewritten', () => {
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(6);
    for (const table of TABLES) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    expect(sql).not.toMatch(/CREATE TABLE "/);
    expect(sql).not.toMatch(/DROP |DELETE FROM|^UPDATE /m);
    expect(sql.match(/CREATE INDEX(?! IF NOT EXISTS)/g)).toBeNull();
    // The only ALTER: the explicit §1.1 mode on bots, re-runnable, with a
    // constant default (no rewrite; the previous image's bots read 'all').
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(sql).toContain(
      `ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "channel_access_mode" text DEFAULT 'all' NOT NULL\n  CONSTRAINT "bots_channel_access_mode_check" CHECK ("channel_access_mode" IN ('all', 'selected'));`
    );
  });

  it('indexes the interaction FKs a channel / command delete walks', () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "idx_bot_interactions_channel" ON "bot_interactions" USING btree ("channel_id");');
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_bot_interactions_command" ON "bot_interactions" USING btree ("command_id") WHERE command_id IS NOT NULL;'
    );
  });

  it('keeps the managers’ command switches per (bot, name), gone with the bot', () => {
    expect(sql).toContain('CONSTRAINT "bot_command_overrides_bot_id_name_pk" PRIMARY KEY ("bot_id","name")');
    expect(sql).toContain('"bot_command_overrides_bot_id_bots_id_fk"\n    FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE cascade');
    expect(sql).toContain('"bot_command_overrides_updated_by_users_id_fk"\n    FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE set null');
    expect(sql).toContain(`CONSTRAINT "bot_command_overrides_name_check" CHECK ("name" ~ '^[a-z0-9_-]{1,32}$')`);
  });

  it('cascades with bots, servers and channels; user references survive the user where they should', () => {
    for (const table of TABLES) {
      expect(sql).toMatch(new RegExp(`"${table}_bot_id_bots_id_fk"[\\s\\S]*?ON DELETE cascade|"${table}_server_id_servers_id_fk"[\\s\\S]*?ON DELETE cascade`));
    }
    expect(sql).toContain('"bot_channel_access_channel_id_channels_id_fk"\n    FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE cascade');
    expect(sql).toContain('FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE set null');
    expect(sql).toContain('FOREIGN KEY ("command_id") REFERENCES "bot_commands"("id") ON DELETE set null');
    expect(sql).toContain('FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null');
    expect(sql).toContain('"bot_interactions_user_id_users_id_fk"\n    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade');
  });

  it('carries the contract’s rules as CHECKs and uniques', () => {
    expect(sql).toContain(`CONSTRAINT "bot_commands_server_id_name_unique" UNIQUE ("server_id","name")`);
    expect(sql).toContain(`CHECK ("name" ~ '^[a-z0-9_-]{1,32}$')`);
    expect(sql).toContain('CHECK (char_length("description") BETWEEN 1 AND 100)');
    expect(sql).toContain(`CHECK (CASE WHEN jsonb_typeof("options") = 'array' THEN jsonb_array_length("options") <= 25 ELSE false END)`);
    expect(sql).toContain(`CHECK ("status" IN ('pending', 'answered', 'expired', 'failed'))`);
    expect(sql).toContain('CHECK ("followup_count" BETWEEN 0 AND 5)');
    expect(sql).toContain('CHECK (char_length("name") BETWEEN 1 AND 32)');
    expect(sql).toContain(`CHECK ("token_hash" ~ '^sha256\\$[0-9a-f]{64}$')`);
    expect(sql).toContain(`CHECK (char_length("url") <= 512 AND "url" LIKE 'https://%')`);
    expect(sql).toContain('CHECK (char_length("secret") BETWEEN 32 AND 128)');
    expect(sql).toContain('PRIMARY KEY ("bot_id","channel_id")');
  });

  it('splits into single statements the migrator can run one by one', () => {
    const statements = sql
      .split('--> statement-breakpoint')
      .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    expect(statements).toHaveLength(15); // 1 column + 6 tables + 8 indexes
    expect(statements.every((statement) => statement.split(';').filter((s) => s.trim()).length === 1)).toBe(true);
  });

  it('is journal entry 42 and its snapshot chains from 0043 with the six tables and the bots column', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0044_bot_api_v2');
    expect(entry?.idx).toBe(42);
    const prevEntry = journal.entries.find((e) => e.tag === '0043_server_join_requests');
    expect(entry!.when).toBeGreaterThan(prevEntry!.when);

    const prev = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0043_snapshot.json'), 'utf8')) as {
      id: string;
      tables: Record<string, unknown>;
    };
    const snapshot = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0044_snapshot.json'), 'utf8')) as {
      id: string;
      prevId: string;
      tables: Record<string, { columns: Record<string, { type: string; notNull: boolean; default?: unknown }>; compositePrimaryKeys: Record<string, unknown>; uniqueConstraints: Record<string, unknown> }>;
    };
    expect(snapshot.prevId).toBe(prev.id);
    expect(snapshot.id).not.toBe(prev.id);
    for (const table of TABLES) expect(snapshot.tables[`public.${table}`]).toBeDefined();
    // Every table of 0043 is still there, unchanged — except bots, which
    // gains exactly one column.
    for (const [key, value] of Object.entries(prev.tables)) {
      if (key === 'public.bots') continue;
      expect(snapshot.tables[key]).toEqual(value);
    }
    const prevBots = prev.tables['public.bots'] as { columns: Record<string, unknown> };
    const bots = snapshot.tables['public.bots']!;
    expect({ ...bots, columns: Object.fromEntries(Object.entries(bots.columns).filter(([k]) => k !== 'channel_access_mode')) }).toEqual(prevBots);
    expect(bots.columns.channel_access_mode).toMatchObject({ type: 'text', notNull: true, default: "'all'" });
    expect(snapshot.tables['public.bot_command_overrides']!.compositePrimaryKeys).toHaveProperty('bot_command_overrides_bot_id_name_pk');
    expect(Object.keys((snapshot.tables['public.bot_interactions'] as unknown as { indexes: Record<string, unknown> }).indexes).sort()).toEqual([
      'idx_bot_interactions_bot_status',
      'idx_bot_interactions_channel',
      'idx_bot_interactions_command',
      'idx_bot_interactions_user',
    ]);
    expect(Object.keys(snapshot.tables['public.bot_interactions']!.columns)).toEqual([
      'id', 'bot_id', 'command_id', 'server_id', 'channel_id', 'user_id', 'command_name', 'options', 'status',
      'response', 'followup_count', 'created_at', 'answered_at', 'expires_at',
    ]);
    expect(snapshot.tables['public.bot_commands']!.uniqueConstraints).toHaveProperty('bot_commands_server_id_name_unique');
    expect(snapshot.tables['public.bot_channel_access']!.compositePrimaryKeys).toHaveProperty('bot_channel_access_bot_id_channel_id_pk');
    expect(snapshot.tables['public.bot_event_endpoints']!.columns.failure_count).toMatchObject({ type: 'integer', notNull: true, default: 0 });
  });
});
