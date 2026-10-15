/**
 * findOrCreateDmChannel / findDmChannelByPair (security review 2026-10, A8):
 *
 *  - the pair is ordered on LOWER-CASED ids — Postgres stores a uuid in
 *    lower case, JavaScript orders "A" before "a", so an upper-case id
 *    could order the pair the other way round (a second conversation for
 *    the same two people);
 *  - two first messages at once no longer race into the pair's unique
 *    index: the insert does nothing on conflict and the winner is read back;
 *  - a row the bug stored the other way round is still found.
 *
 * Query-level unit tests against a recording fake client (no Postgres).
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { findDmChannelByPair, findOrCreateDmChannel } from '../queries/dmChannels.js';

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
  return {
    db: {
      select: (...args: unknown[]) => start('select', args),
      insert: (...args: unknown[]) => start('insert', args),
    } as never,
    chains,
  };
}

function whereParams(chain: Step[] | undefined): unknown[] {
  const where = chain?.find((s) => s.op === 'where');
  return new PgDialect().sqlToQuery(where!.args[0] as SQL).params;
}

// `LOW` < `HIGH` in lower case; in upper case `HIGH_UPPER` sorts before `LOW`.
const LOW = 'aaaaaaaa-0000-4000-8000-000000000001';
const HIGH = 'bbbbbbbb-0000-4000-8000-000000000002';
const HIGH_UPPER = HIGH.toUpperCase();

function row(userAId: string, userBId: string) {
  return { id: 'dm-1', userAId, userBId, createdBy: userAId, lastMessageAt: new Date(), createdAt: new Date() };
}

describe('findOrCreateDmChannel', () => {
  it('orders the pair on lower-cased ids, whichever case the caller sent', async () => {
    const existing = row(LOW, HIGH);
    const { db, chains } = recordingDb([[existing]]);
    expect(await findOrCreateDmChannel(db, LOW, HIGH_UPPER)).toBe(existing);
    expect(whereParams(chains[0])).toEqual([LOW, HIGH]);
    expect(chains).toHaveLength(1);
  });

  it('finds a conversation stored the other way round (no migration rewrites it)', async () => {
    const reversed = row(HIGH, LOW);
    const { db, chains } = recordingDb([[], [reversed]]);
    expect(await findOrCreateDmChannel(db, HIGH, LOW)).toBe(reversed);
    expect(whereParams(chains[1])).toEqual([HIGH, LOW]);
    expect(chains.some((chain) => chain[0]!.op === 'insert')).toBe(false);
  });

  it('inserts the canonical pair, doing nothing on the pair index conflict', async () => {
    const created = row(LOW, HIGH);
    const { db, chains } = recordingDb([[], [], [created]]);
    expect(await findOrCreateDmChannel(db, HIGH_UPPER, LOW)).toBe(created);
    const insert = chains[2]!;
    expect(insert[0]!.op).toBe('insert');
    expect(insert.find((s) => s.op === 'values')!.args[0]).toEqual({ userAId: LOW, userBId: HIGH, createdBy: HIGH });
    const conflict = insert.find((s) => s.op === 'onConflictDoNothing');
    expect(conflict).toBeTruthy();
    const target = (conflict!.args[0] as { target: Array<{ name: string }> }).target.map((column) => column.name);
    expect(target).toEqual(['user_a_id', 'user_b_id']);
  });

  it('a concurrent request that created it first wins: its row is read back', async () => {
    const winner = row(LOW, HIGH);
    const { db, chains } = recordingDb([[], [], [], [winner]]);
    expect(await findOrCreateDmChannel(db, LOW, HIGH)).toBe(winner);
    expect(chains.map((chain) => chain[0]!.op)).toEqual(['select', 'select', 'insert', 'select']);
    expect(whereParams(chains[3])).toEqual([LOW, HIGH]);
  });
});

describe('findDmChannelByPair', () => {
  it('looks the pair up in lower case and in both orders, preferring the canonical row', async () => {
    const { db, chains } = recordingDb([[{ id: 'dm-1' }]]);
    expect(await findDmChannelByPair(db, HIGH_UPPER, LOW)).toBe('dm-1');
    expect(whereParams(chains[0])).toEqual([LOW, HIGH, HIGH, LOW]);
    expect(chains[0]!.some((s) => s.op === 'orderBy')).toBe(true);
  });
});
