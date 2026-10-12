/**
 * 0049_activity_timers — the migration file, journal and snapshot, read
 * from disk (no database) — and the two queries phase 3 of the plugin
 * unlock added around it: the timers ride in the session's CAS write and
 * are dropped when it ends; a plugin's storage writes go in one batch,
 * under a (community, plugin) lock, refused whole past the limit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gameSessions } from '../schema.js';
import { PluginStorageFullError, pluginDataLockKey, writePluginDataBatch } from '../queries/pluginData.js';
import type { DbClient } from '../client.js';

const drizzleDir = join(__dirname, '..', '..', 'drizzle');
const sql = readFileSync(join(drizzleDir, '0049_activity_timers.sql'), 'utf8');

function statements(): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

describe('0049_activity_timers', () => {
  it('adds game_sessions.timers, a JSON array defaulting to empty, idempotently and nothing else', () => {
    expect(statements()).toEqual([
      `ALTER TABLE "game_sessions" ADD COLUMN IF NOT EXISTS "timers" jsonb DEFAULT '[]'::jsonb NOT NULL;`,
    ]);
    expect(sql).not.toMatch(/DROP |RENAME|TRUNCATE|DELETE FROM|UPDATE /);
  });

  it('matches the Drizzle schema', () => {
    expect(gameSessions.timers.getSQLType()).toBe('jsonb');
    expect(gameSessions.timers.notNull).toBe(true);
    expect(gameSessions.timers.default).toEqual([]);
  });

  it('is journal entry 47 and its snapshot chains from 0048 with only the new column', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0049_activity_timers');
    expect(entry?.idx).toBe(47);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.tag === '0048_account_language')!.when);

    type Snapshot = { id: string; prevId: string; tables: Record<string, { columns: Record<string, unknown> }> };
    const prev = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0048_snapshot.json'), 'utf8')) as Snapshot;
    const snapshot = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0049_snapshot.json'), 'utf8')) as Snapshot;
    expect(snapshot.prevId).toBe(prev.id);
    expect(snapshot.id).not.toBe(prev.id);
    expect(Object.keys(snapshot.tables).sort()).toEqual(Object.keys(prev.tables).sort());
    for (const [key, table] of Object.entries(prev.tables)) {
      if (key !== 'public.game_sessions') expect(snapshot.tables[key]).toEqual(table);
    }
    const { timers, ...rest } = snapshot.tables['public.game_sessions']!.columns;
    expect(rest).toEqual(prev.tables['public.game_sessions']!.columns);
    expect(timers).toEqual({ name: 'timers', type: 'jsonb', primaryKey: false, notNull: true, default: "'[]'::jsonb" });
  });
});

/** A transaction that records what it is asked to do, over an in-memory table. */
function fakeDb(rows: Array<{ key: string; value: unknown }>) {
  const log: string[] = [];
  const tx = {
    execute: async () => {
      log.push('lock');
    },
    select: () => ({ from: () => ({ where: async () => rows.map((r) => ({ ...r })) }) }),
    delete: () => ({
      where: async () => {
        log.push('delete');
      },
    }),
    insert: () => ({
      values: (value: { key: string; value: unknown }) => ({
        onConflictDoUpdate: async () => {
          log.push(`upsert:${value.key}`);
        },
      }),
    }),
  };
  const db = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      log.push('begin');
      try {
        return await fn(tx);
      } finally {
        log.push('end');
      }
    },
  };
  return { db: db as unknown as DbClient, log };
}

const sizeOf = (entries: Record<string, unknown>) =>
  Object.keys(entries).reduce((total, key) => total + key.length + JSON.stringify(entries[key]).length, 0);

describe('writePluginDataBatch', () => {
  it('locks (community, plugin), then writes every key of the batch in one transaction', async () => {
    const { db, log } = fakeDb([{ key: 'old', value: 1 }]);
    await writePluginDataBatch(db, 's', 'p', [{ key: 'a', value: 1 }, { key: 'old', delete: true }], { maxBytes: 100, sizeOf });
    expect(log).toEqual(['begin', 'lock', 'upsert:a', 'delete', 'end']);
    expect(pluginDataLockKey('s', 'p')).toBe('lobbyforge:plugin-data:s:p');
  });

  it('measures the storage as it stands under the lock and refuses the whole batch past the limit', async () => {
    const { db, log } = fakeDb([{ key: 'big', value: 'x'.repeat(80) }]);
    await expect(
      writePluginDataBatch(db, 's', 'p', [{ key: 'more', value: 'y'.repeat(30) }], { maxBytes: 100, sizeOf })
    ).rejects.toBeInstanceOf(PluginStorageFullError);
    expect(log).toEqual(['begin', 'lock', 'end']);
  });

  it('refuses a malformed key before touching the database, and does nothing for an empty batch', async () => {
    const { db, log } = fakeDb([]);
    await expect(writePluginDataBatch(db, 's', 'p', [{ key: 'a/b', value: 1 }], { maxBytes: 100, sizeOf })).rejects.toThrow();
    await writePluginDataBatch(db, 's', 'p', [], { maxBytes: 100, sizeOf });
    expect(log).toEqual([]);
  });

  it('a key named __proto__ already in the table is an ordinary key', async () => {
    const { db } = fakeDb([{ key: '__proto__', value: { polluted: true } }]);
    await writePluginDataBatch(db, 's', 'p', [{ key: 'a', value: 1 }], { maxBytes: 1000, sizeOf });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
