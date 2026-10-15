/**
 * 0050_profile_fields — the migration file, journal and snapshot, read from
 * disk (no database) — and the queries around the three new columns.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { users } from '../schema.js';
import { updateUserProfile, UsernameTakenError } from '../queries/users.js';
import { updateMessage } from '../queries/messages.js';
import type { DbClient } from '../client.js';

const drizzleDir = join(__dirname, '..', '..', 'drizzle');
const sql = readFileSync(join(drizzleDir, '0050_profile_fields.sql'), 'utf8');

function statements(): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

describe('0050_profile_fields', () => {
  it('adds three nullable columns and named constraints, each only when missing, and nothing else', () => {
    const [username, pronouns, accent, constraints] = statements();
    expect(username).toBe('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username" text;');
    expect(pronouns).toBe('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "pronouns" varchar(40);');
    expect(accent).toBe('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "accent_color" varchar(7);');
    expect(constraints).toContain(`ADD CONSTRAINT "users_username_unique" UNIQUE ("username")`);
    expect(constraints).toContain(`CHECK ("username" ~ '^[a-z0-9_.]{2,32}$')`);
    expect(constraints).toContain(`CHECK ("accent_color" ~ '^#[0-9a-f]{6}$')`);
    expect((constraints!.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g) ?? []).length).toBe(3);
    expect(statements()).toHaveLength(4);
    expect(sql).not.toMatch(/DROP |RENAME|TRUNCATE|DELETE FROM|UPDATE |NOT NULL/);
  });

  it('matches the Drizzle schema', () => {
    expect(users.username.getSQLType()).toBe('text');
    expect(users.username.isUnique).toBe(true);
    expect(users.username.notNull).toBe(false);
    expect(users.pronouns.getSQLType()).toBe('varchar(40)');
    expect(users.accentColor.getSQLType()).toBe('varchar(7)');
  });

  it('is journal entry 48 and its snapshot chains from 0049 with only the new columns and constraint', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0050_profile_fields');
    expect(entry?.idx).toBe(48);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.tag === '0049_activity_timers')!.when);

    type Table = { columns: Record<string, unknown>; uniqueConstraints: Record<string, unknown> };
    type Snapshot = { id: string; prevId: string; tables: Record<string, Table> };
    const prev = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0049_snapshot.json'), 'utf8')) as Snapshot;
    const snapshot = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0050_snapshot.json'), 'utf8')) as Snapshot;
    expect(snapshot.prevId).toBe(prev.id);
    expect(snapshot.id).not.toBe(prev.id);
    for (const [key, table] of Object.entries(prev.tables)) {
      if (key !== 'public.users') expect(snapshot.tables[key]).toEqual(table);
    }
    const { username, pronouns, accent_color, ...rest } = snapshot.tables['public.users']!.columns;
    expect(rest).toEqual(prev.tables['public.users']!.columns);
    expect(username).toEqual({ name: 'username', type: 'text', primaryKey: false, notNull: false });
    expect(pronouns).toEqual({ name: 'pronouns', type: 'varchar(40)', primaryKey: false, notNull: false });
    expect(accent_color).toEqual({ name: 'accent_color', type: 'varchar(7)', primaryKey: false, notNull: false });
    const { users_username_unique, ...otherUniques } = snapshot.tables['public.users']!.uniqueConstraints;
    expect(otherUniques).toEqual(prev.tables['public.users']!.uniqueConstraints);
    expect(users_username_unique).toEqual({ name: 'users_username_unique', nullsNotDistinct: false, columns: ['username'] });
  });
});

/** An update that records what it set, or fails the way Postgres does. */
function updateDb(result: () => unknown[]) {
  const set = vi.fn();
  const db = {
    update: () => ({
      set: (values: unknown) => {
        set(values);
        return { where: () => ({ returning: async () => result() }) };
      },
    }),
  };
  return { db: db as unknown as DbClient, set };
}

describe('updateUserProfile — 0050 fields', () => {
  it('stores the handle and colour lowercase, trims pronouns, clears empties', async () => {
    const { db, set } = updateDb(() => [{ id: 'u1' }]);
    await updateUserProfile(db, 'u1', { username: ' Ada ', pronouns: ' she/her ', accentColor: '#ABCDEF' });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ username: 'ada', pronouns: 'she/her', accentColor: '#abcdef' }));
    await updateUserProfile(db, 'u1', { username: '', pronouns: null, accentColor: null });
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ username: null, pronouns: null, accentColor: null }));
  });

  it('a handle someone holds becomes UsernameTakenError; other failures pass through', async () => {
    const unique = Object.assign(new Error('dup'), { cause: { code: '23505' } });
    await expect(updateUserProfile(updateDb(() => { throw unique; }).db, 'u1', { username: 'ada' })).rejects.toBeInstanceOf(
      UsernameTakenError
    );
    await expect(updateUserProfile(updateDb(() => { throw unique; }).db, 'u1', { bio: 'x' })).rejects.toBe(unique);
  });
});

describe('updateMessage', () => {
  it('only a new text stamps edited_at — a pin (metadata) does not', async () => {
    const { db, set } = updateDb(() => [{ id: 'm1' }]);
    await updateMessage(db, 'm1', { metadata: { $pinnedAt: 'x' } });
    expect(set.mock.calls[0]![0]).toEqual({ metadata: { $pinnedAt: 'x' } });
    await updateMessage(db, 'm1', { content: 'new' });
    expect(set.mock.calls[1]![0]).toMatchObject({ content: 'new', editedAt: expect.any(Date) });
  });
});
