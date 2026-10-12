/**
 * 0048_account_language — the migration file, journal and snapshot, read
 * from disk (no database). The SQL itself (the guarded backfill, the new
 * column and the queries over them) runs in
 * account-language.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { instanceSettings, users } from '../schema.js';

const drizzleDir = join(__dirname, '..', '..', 'drizzle');
const sql = readFileSync(join(drizzleDir, '0048_account_language.sql'), 'utf8');

function statements(): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

describe('0048_account_language', () => {
  it('makes users.locale nullable with no default, and clears the never-written "en" rows', () => {
    const [block] = statements();
    expect(block).toMatch(/^DO \$\$ BEGIN/);
    expect(block).toContain('ALTER TABLE "users" ALTER COLUMN "locale" DROP DEFAULT;');
    expect(block).toContain('ALTER TABLE "users" ALTER COLUMN "locale" DROP NOT NULL;');
    expect(block).toContain(`UPDATE "users" SET "locale" = NULL WHERE "locale" = 'en';`);
  });

  it('runs the backfill only while the column is still NOT NULL, so a re-run never clears a real English choice', () => {
    const [block] = statements();
    const guard = block!.indexOf("is_nullable = 'NO'");
    expect(guard).toBeGreaterThan(-1);
    expect(block).toContain("table_name = 'users'");
    expect(block).toContain("column_name = 'locale'");
    // Every change sits inside the guarded IF.
    for (const change of ['DROP DEFAULT', 'DROP NOT NULL', 'UPDATE "users"']) {
      expect(block!.indexOf(change)).toBeGreaterThan(guard);
      expect(block!.indexOf(change)).toBeLessThan(block!.indexOf('END IF;'));
    }
    // Only the locale column, only the users table.
    expect(sql.match(/^\s*UPDATE /gm)).toHaveLength(1);
  });

  it('adds instance_settings.default_locale, nullable, idempotently', () => {
    expect(statements()[1]).toBe('ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "default_locale" text;');
  });

  it('drops, renames and rewrites nothing', () => {
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|RENAME|TRUNCATE|DELETE FROM|ALTER COLUMN "[a-z_]+" TYPE|SET NOT NULL/);
  });

  it('splits into statements the migrator can run one by one', () => {
    expect(statements()).toHaveLength(2);
  });

  it('matches the Drizzle schema', () => {
    expect(users.locale.notNull).toBe(false);
    expect(users.locale.default).toBeUndefined();
    expect(users.locale.getSQLType()).toBe('text');
    expect(instanceSettings.defaultLocale.notNull).toBe(false);
    expect(instanceSettings.defaultLocale.default).toBeUndefined();
    expect(instanceSettings.defaultLocale.getSQLType()).toBe('text');
  });

  it('is journal entry 46 and its snapshot chains from 0047 with exactly these two column changes', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0048_account_language');
    expect(entry?.idx).toBe(46);
    const prevEntry = journal.entries.find((e) => e.tag === '0047_chat_polls');
    expect(entry!.when).toBeGreaterThan(prevEntry!.when);

    type Column = { name: string; type: string; notNull: boolean; default?: unknown; primaryKey: boolean };
    type Snapshot = { id: string; prevId: string; tables: Record<string, { columns: Record<string, Column> }> };
    const prev = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0047_snapshot.json'), 'utf8')) as Snapshot;
    const snapshot = JSON.parse(readFileSync(join(drizzleDir, 'meta', '0048_snapshot.json'), 'utf8')) as Snapshot;
    expect(snapshot.prevId).toBe(prev.id);
    expect(snapshot.id).not.toBe(prev.id);
    expect(Object.keys(snapshot.tables).sort()).toEqual(Object.keys(prev.tables).sort());

    for (const [key, table] of Object.entries(prev.tables)) {
      if (key === 'public.users' || key === 'public.instance_settings') continue;
      expect(snapshot.tables[key]).toEqual(table);
    }
    const { locale: oldLocale, ...prevUsers } = prev.tables['public.users']!.columns;
    const { locale, ...nextUsers } = snapshot.tables['public.users']!.columns;
    expect(oldLocale).toMatchObject({ notNull: true, default: "'en'" });
    expect(locale).toEqual({ name: 'locale', type: 'text', primaryKey: false, notNull: false });
    expect(nextUsers).toEqual(prevUsers);

    const { default_locale, ...nextSettings } = snapshot.tables['public.instance_settings']!.columns;
    expect(default_locale).toEqual({ name: 'default_locale', type: 'text', primaryKey: false, notNull: false });
    expect(nextSettings).toEqual(prev.tables['public.instance_settings']!.columns);
  });
});
