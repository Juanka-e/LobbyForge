/**
 * Security review (marketplace): an approval is written only while the
 * catalogue row is still the submission the reviewer saw — its version and,
 * for an approval, the bundle URL that was downloaded and pinned — in the
 * same UPDATE. Run against a capturing fake client (no Postgres needed).
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { reviewPlugin } from '../queries/pluginCatalog.js';

interface Captured {
  patch?: Record<string, unknown>;
  where?: SQL;
}

function fakeDb(captured: Captured, returning: unknown[]) {
  return {
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        captured.patch = patch;
        return {
          where: (where: SQL) => {
            captured.where = where;
            return { returning: async () => returning };
          },
        };
      },
    }),
  } as never;
}

function render(where: SQL | undefined): { sql: string; params: unknown[] } {
  if (!where) throw new Error('no WHERE captured');
  return new PgDialect().sqlToQuery(where);
}

const PIN = { sha256: 'a'.repeat(64), sizeBytes: 123 };

describe('reviewPlugin — the guarded update', () => {
  it('matches the plugin, the version and the downloaded bundle URL in one WHERE', async () => {
    const captured: Captured = {};
    const ok = await reviewPlugin(fakeDb(captured, [{ pluginId: 'game' }]), 'game', 'approved', null, null, PIN, {
      version: '1.0.0',
      manifestUrl: 'https://cdn.example.com/game.tgz',
    });
    expect(ok).toBe(true);
    const where = render(captured.where);
    expect(where.sql).toContain('"plugin_id" = $1');
    expect(where.sql).toContain('"version" = $2');
    expect(where.sql).toContain('"manifest_url" = $3');
    expect(where.params).toEqual(['game', '1.0.0', 'https://cdn.example.com/game.tgz']);
    expect(captured.patch).toMatchObject({ reviewStatus: 'approved', bundleSha256: PIN.sha256, bundleSizeBytes: 123 });
  });

  it('reports a row that changed in between (nothing updated) as false', async () => {
    const ok = await reviewPlugin(fakeDb({}, []), 'game', 'approved', null, null, PIN, { version: '1.0.0', manifestUrl: null });
    expect(ok).toBe(false);
  });

  it('a null bundle URL is matched as NULL, and no expectation keeps the plain update', async () => {
    const guarded: Captured = {};
    await reviewPlugin(fakeDb(guarded, [{}]), 'game', 'rejected', null, null, undefined, { version: '1.0.0', manifestUrl: null });
    expect(render(guarded.where).sql).toContain('"manifest_url" is null');

    const plain: Captured = {};
    await reviewPlugin(fakeDb(plain, [{}]), 'game', 'delisted', null, null);
    const where = render(plain.where);
    expect(where.sql).not.toContain('"version"');
    expect(where.params).toEqual(['game']);
  });
});
