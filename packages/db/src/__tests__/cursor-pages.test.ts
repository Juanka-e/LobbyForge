/**
 * Newest-first pages with a `before` cursor (security review 2026-10, A11).
 *
 * `created_at` has microseconds, the cursor a client sends back (the last
 * row's createdAt, a JS Date) only milliseconds, and `created_at < before`
 * leaves out the whole millisecond — so when LIMIT cut a page inside a
 * millisecond, its older rows were on neither page. Pages are now
 * millisecond-complete: a full page carries the rest of its last
 * millisecond, and the next page starts below it.
 *
 * The helper on its own, then each query (messages, DMs, audit log)
 * against a recording fake client (no Postgres).
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { completeLastMillisecond } from '../queries/pagination.js';
import { listMessagesForChannel } from '../queries/messages.js';
import { listDmMessages } from '../queries/dmChannels.js';
import { listAuditLogsForServer } from '../queries/auditLogs.js';

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

function whereOf(chain: Step[] | undefined): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(chain!.find((s) => s.op === 'where')!.args[0] as SQL);
}

function orderSql(chain: Step[] | undefined): string {
  const args = chain!.find((s) => s.op === 'orderBy')!.args as SQL[];
  return args.map((arg) => new PgDialect().sqlToQuery(arg).sql).join(', ');
}

const MS = new Date('2026-10-15T12:00:00.123Z');
const EARLIER = new Date('2026-10-15T12:00:00.100Z');
const row = (id: string, createdAt: Date) => ({ id, createdAt });

describe('completeLastMillisecond', () => {
  it('a short page is the last one: nothing more is asked', async () => {
    let asked = false;
    const page = [row('a', MS)];
    expect(await completeLastMillisecond(page, 2, async () => ((asked = true), []))).toBe(page);
    expect(asked).toBe(false);
  });

  it('a full page asks for the rest of its last millisecond, naming the rows it already has', async () => {
    const calls: Array<{ boundary: Date; seen: string[] }> = [];
    const page = [row('a', EARLIER), row('b', MS), row('c', MS)];
    // Note: rows come newest first; `EARLIER` first here only to show that
    // only the LAST row's millisecond counts.
    const result = await completeLastMillisecond(page, 3, async (boundary, seen) => {
      calls.push({ boundary, seen });
      return [row('d', MS)];
    });
    expect(calls).toEqual([{ boundary: MS, seen: ['b', 'c'] }]);
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a full page whose millisecond is complete stays as it is', async () => {
    const page = [row('a', MS), row('b', EARLIER)];
    expect(await completeLastMillisecond(page, 2, async () => [])).toBe(page);
  });
});

const CHANNEL = 'cccccccc-0000-4000-8000-000000000001';
const SERVER = 'dddddddd-0000-4000-8000-000000000001';

function full(n: number, last: Date) {
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, createdAt: i === n - 1 ? last : new Date(last.getTime() + 1000) }));
}

/** The second query: the boundary millisecond as a range, minus the rows the page has. */
function expectRestQuery(chain: Step[] | undefined, column: string, seenId: string) {
  const where = whereOf(chain);
  expect(where.sql).toContain(`"${column}" >= $`);
  expect(where.sql).toContain(`"${column}" < $`);
  expect(where.sql).toMatch(/"id" not in \(\$\d+\)/);
  expect(where.params).toContain(MS.toISOString());
  expect(where.params).toContain(new Date(MS.getTime() + 1).toISOString());
  expect(where.params).toContain(seenId);
}

describe('listMessagesForChannel', () => {
  it('a full page carries the rest of its last millisecond, in the same stable order', async () => {
    const page = full(2, MS);
    const rest = [{ id: 'older-same-ms', createdAt: MS }];
    // assertChannelAlive, the page, the rest of the millisecond.
    const { db, chains } = recordingDb([[{ id: CHANNEL }], page, rest]);
    const rows = await listMessagesForChannel(db, CHANNEL, { limit: 2, before: new Date('2026-10-15T13:00:00.000Z') });
    expect(rows.map((r) => r.id)).toEqual(['r0', 'r1', 'older-same-ms']);
    expect(orderSql(chains[1])).toBe('"messages"."created_at" desc, "messages"."id" desc');
    expect(chains[1]!.find((s) => s.op === 'limit')!.args[0]).toBe(2);
    expect(whereOf(chains[1]).sql).toContain('"messages"."created_at" < $');
    expectRestQuery(chains[2], 'created_at', 'r1');
    expect(chains[2]!.some((s) => s.op === 'limit')).toBe(false);
  });

  it('a short page asks nothing more', async () => {
    const { db, chains } = recordingDb([[{ id: CHANNEL }], [{ id: 'only', createdAt: MS }]]);
    expect(await listMessagesForChannel(db, CHANNEL, { limit: 50 })).toHaveLength(1);
    expect(chains).toHaveLength(2);
  });
});

describe('listDmMessages', () => {
  it('a full page carries the rest of its last millisecond', async () => {
    const { db, chains } = recordingDb([full(3, MS), [{ id: 'older-same-ms', createdAt: MS }]]);
    const rows = await listDmMessages(db, CHANNEL, { limit: 3 });
    expect(rows.map((r) => r.id)).toEqual(['r0', 'r1', 'r2', 'older-same-ms']);
    expect(orderSql(chains[0])).toBe('"dm_messages"."created_at" desc, "dm_messages"."id" desc');
    expectRestQuery(chains[1], 'created_at', 'r2');
  });
});

describe('listAuditLogsForServer', () => {
  it('a full page carries the rest of its last millisecond', async () => {
    const { db, chains } = recordingDb([full(2, MS), []]);
    const rows = await listAuditLogsForServer(db, SERVER, { limit: 2, before: new Date('2026-10-16T00:00:00.000Z') });
    expect(rows).toHaveLength(2);
    expect(orderSql(chains[0])).toBe('"audit_logs"."created_at" desc, "audit_logs"."id" desc');
    expect(whereOf(chains[0]).sql).toContain('"audit_logs"."created_at" < $');
    expectRestQuery(chains[1], 'created_at', 'r1');
  });
});
