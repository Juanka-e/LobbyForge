/**
 * 0047_chat_polls — the migration file, journal and snapshot, read from
 * disk (no database). The SQL itself (tables, cascades, the role backfill
 * and the vote queries) runs in chat-polls.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CorePermission } from '@lobbyforge/core';
import { messagePollVotes, messagePolls } from '../schema.js';
import { DEFAULT_ADMIN_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } from '../queries/roles.js';

const drizzleDir = join(__dirname, '..', '..', 'drizzle');
const sql = readFileSync(join(drizzleDir, '0047_chat_polls.sql'), 'utf8');

function statements(): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

describe('0047_chat_polls', () => {
  it('is expand-only and idempotent', () => {
    expect(sql.match(/CREATE TABLE IF NOT EXISTS "message_polls"/g)).toHaveLength(1);
    expect(sql.match(/CREATE TABLE IF NOT EXISTS "message_poll_votes"/g)).toHaveLength(1);
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(2);
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "message_polls_message_id_unique" ON "message_polls" USING btree ("message_id");');
    expect(sql).not.toMatch(/DROP |DELETE FROM|ALTER COLUMN|RENAME|TRUNCATE|ALTER TABLE "messages"/);
    // The only UPDATE is the role backfill, and it skips roles that already have the permission.
    expect(sql.match(/^UPDATE /gm)).toHaveLength(1);
    expect(sql).toContain(`AND NOT ("permissions" @> '["create_polls"]'::jsonb)`);
  });

  it('cascades from the message, the channel and the poll; keeps the poll when its creator is deleted', () => {
    expect(sql).toContain('FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE cascade');
    expect(sql).toContain('FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE cascade');
    expect(sql).toContain('FOREIGN KEY ("creator_user_id") REFERENCES "users"("id") ON DELETE set null');
    expect(sql).toContain('FOREIGN KEY ("poll_id") REFERENCES "message_polls"("id") ON DELETE cascade');
    expect(sql).toContain('FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade');
  });

  it('versions every write so a late realtime update can be dropped', () => {
    expect(sql).toContain('"version" integer DEFAULT 0 NOT NULL');
  });

  it('backstops the route limits in SQL', () => {
    expect(sql).toContain('CHECK (char_length("question") BETWEEN 1 AND 300)');
    expect(sql).toContain(`CHECK (jsonb_typeof("options") = 'array' AND jsonb_array_length("options") BETWEEN 2 AND 10)`);
    expect(sql).toContain('CHECK ("option_index" BETWEEN 0 AND 9)');
    expect(sql).toContain('PRIMARY KEY ("poll_id", "user_id", "option_index")');
  });

  it('grants create_polls to admin and moderator-style roles, never to @everyone', () => {
    const backfill = statements().find((s) => s.startsWith('UPDATE'))!;
    expect(backfill).toContain(`"name" <> '@everyone'`);
    expect(backfill).toContain(`"permissions" @> '["administrator"]'::jsonb OR "permissions" @> '["manage_messages"]'::jsonb`);
    expect(DEFAULT_ADMIN_PERMISSIONS).toContain(CorePermission.CREATE_POLLS);
    expect(DEFAULT_EVERYONE_PERMISSIONS).not.toContain(CorePermission.CREATE_POLLS);
  });

  it('splits into single statements the migrator can run one by one', () => {
    const parts = statements();
    // 2 tables + 1 index + the backfill.
    expect(parts).toHaveLength(4);
    expect(parts.every((statement) => statement.split(';').filter((s) => s.trim()).length === 1)).toBe(true);
  });

  it('matches the Drizzle schema', () => {
    expect(messagePolls.allowMultiple.default).toBe(false);
    expect(messagePolls.allowMultiple.notNull).toBe(true);
    expect(messagePolls.closedAt.notNull).toBe(false);
    expect(messagePolls.creatorUserId.notNull).toBe(false);
    expect(messagePolls.options.getSQLType()).toBe('jsonb');
    expect(messagePolls.version.default).toBe(0);
    expect(messagePolls.version.notNull).toBe(true);
    expect(messagePollVotes.optionIndex.getSQLType()).toBe('smallint');
  });

  it('is journal entry 45 and its snapshot chains from 0046 with only the two new tables', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0047_chat_polls');
    expect(entry?.idx).toBe(45);
    const prevEntry = journal.entries.find((e) => e.tag === '0046_email');
    expect(entry!.when).toBeGreaterThan(prevEntry!.when);

    type Snapshot = {
      id: string;
      prevId: string;
      tables: Record<string, {
        columns: Record<string, { type: string; notNull: boolean; default?: unknown }>;
        indexes: Record<string, { isUnique?: boolean }>;
        foreignKeys: Record<string, { onDelete: string }>;
        compositePrimaryKeys: Record<string, { columns: string[] }>;
      }>;
    };
    const prev = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0046_snapshot.json'), 'utf8')) as Snapshot;
    const snapshot = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0047_snapshot.json'), 'utf8')) as Snapshot;
    expect(snapshot.prevId).toBe(prev.id);
    expect(snapshot.id).not.toBe(prev.id);
    for (const [key, value] of Object.entries(prev.tables)) expect(snapshot.tables[key]).toEqual(value);
    expect(Object.keys(snapshot.tables).filter((k) => !(k in prev.tables)).sort()).toEqual([
      'public.message_poll_votes',
      'public.message_polls',
    ]);

    const polls = snapshot.tables['public.message_polls']!;
    expect(Object.keys(polls.columns)).toEqual([
      'id',
      'message_id',
      'channel_id',
      'creator_user_id',
      'question',
      'options',
      'allow_multiple',
      'closes_at',
      'closed_at',
      'closed_by_user_id',
      'version',
      'created_at',
    ]);
    expect(polls.columns.version).toMatchObject({ type: 'integer', notNull: true, default: 0 });
    expect(polls.indexes.message_polls_message_id_unique).toMatchObject({ isUnique: true });
    expect(polls.foreignKeys.message_polls_message_id_messages_id_fk).toMatchObject({ onDelete: 'cascade' });
    const votes = snapshot.tables['public.message_poll_votes']!;
    expect(votes.columns.option_index).toMatchObject({ type: 'smallint', notNull: true });
    expect(votes.compositePrimaryKeys.message_poll_votes_poll_id_user_id_option_index_pk!.columns).toEqual([
      'poll_id',
      'user_id',
      'option_index',
    ]);
  });
});
