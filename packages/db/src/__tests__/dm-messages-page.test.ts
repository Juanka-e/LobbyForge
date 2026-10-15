/**
 * listDmMessages — one page of a DM conversation, newest first.
 *
 * Security review 2026-10 (A9): the route passed `limit` and `before`
 * unchecked, so NaN or an Invalid Date reached the query (a 500). The
 * route now refuses junk; the query also keeps LIMIT within 1..100 and
 * ignores a cursor that is not a date.
 *
 * Query-level unit tests against a recording fake client (no Postgres).
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { listDmMessages } from '../queries/dmChannels.js';

interface Step {
  op: string;
  args: unknown[];
}

function recordingDb(results: unknown[][]) {
  const chains: Step[][] = [];
  let next = 0;
  function start(op: string, args: unknown[]) {
    const steps: Step[] = [{ op, args }];
    chains.push(steps);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            const value = results[next++] ?? [];
            return (resolve: (v: unknown) => void) => resolve(value);
          }
          return (...callArgs: unknown[]) => {
            steps.push({ op: String(prop), args: callArgs });
            return proxy;
          };
        },
      }
    );
    return proxy;
  }
  return { db: { select: (...args: unknown[]) => start('select', args) } as never, chains };
}

const CHANNEL = 'cccccccc-0000-4000-8000-000000000001';

function limitOf(chain: Step[] | undefined): unknown {
  return chain?.find((s) => s.op === 'limit')?.args[0];
}

function whereSql(chain: Step[] | undefined): string {
  return new PgDialect().sqlToQuery(chain!.find((s) => s.op === 'where')!.args[0] as SQL).sql;
}

describe('listDmMessages — the page size', () => {
  it('is 50 by default and stays within 1..100', async () => {
    for (const [limit, expected] of [
      [undefined, 50],
      [20, 20],
      [1000, 100],
      [0, 1],
      [-3, 1],
      [Number.NaN, 50],
    ] as const) {
      const { db, chains } = recordingDb([[]]);
      await listDmMessages(db, CHANNEL, limit === undefined ? {} : { limit });
      expect(limitOf(chains[0]), String(limit)).toBe(expected);
    }
  });

  it('ignores a cursor that is not a date', async () => {
    const { db, chains } = recordingDb([[]]);
    await listDmMessages(db, CHANNEL, { before: new Date('nope') });
    expect(whereSql(chains[0])).not.toContain('created_at');
  });
});
