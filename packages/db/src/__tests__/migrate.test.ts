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
    expect(file).toMatch(/lobbyforge:lobbyforge_dev@localhost:5432\/lobbyforge/);
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
    expect(
      readdirSync(join(drizzleDir, 'meta')).includes(
        `${String(latest!.idx).padStart(4, '0')}_snapshot.json`
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
});
