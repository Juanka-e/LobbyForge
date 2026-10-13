/**
 * security-review FILE-001: the instance-wide stored-image total behind the
 * Doctor's `image_storage` check. Run against a capturing fake client (no
 * Postgres needed): it must measure with octet_length — never select the
 * images, never LIKE them (both would load every multi-MB value).
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { is, SQL } from 'drizzle-orm';
import { getInstanceStoredImageBytes } from '../queries/uploadQuota.js';

function fakeDb(rowsQueue: unknown[][]) {
  const fields: Array<Record<string, unknown>> = [];
  const db = {
    select(projection: Record<string, unknown>) {
      fields.push(projection);
      const rows = rowsQueue.shift() ?? [];
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    },
  };
  return { db: db as never, fields };
}

function render(value: unknown): string {
  if (!is(value, SQL)) throw new Error('expected an SQL fragment');
  return new PgDialect().sqlToQuery(value).sql;
}

describe('getInstanceStoredImageBytes', () => {
  it('sums users (guests split out), server banners and the logo', async () => {
    const { db } = fakeDb([[{ all: '3000', guests: '1000' }], [{ banners: '500' }], [{ logo: '20' }]]);
    await expect(getInstanceStoredImageBytes(db)).resolves.toEqual({
      totalBytes: 3520,
      userBytes: 3000,
      guestBytes: 1000,
      serverBytes: 500,
      logoBytes: 20,
    });
  });

  it('measures with octet_length only — no image column is selected or pattern-matched', async () => {
    const { db, fields } = fakeDb([[], [], []]);
    await expect(getInstanceStoredImageBytes(db)).resolves.toMatchObject({ totalBytes: 0 });
    const statements = fields.flatMap((projection) => Object.values(projection).map(render));
    expect(statements).toHaveLength(4);
    for (const statement of statements) {
      expect(statement).toContain('octet_length(');
      expect(statement.toLowerCase()).not.toContain(' like ');
    }
    expect(statements[1]).toContain('filter (where "users"."is_guest")');
  });
});
