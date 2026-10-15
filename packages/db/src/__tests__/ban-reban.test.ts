/**
 * banUser on a user who is ALREADY actively banned (security review
 * 2026-10, A6). It used to return the old row unchanged while the route
 * answered 201 and audited a `ban.create` — and a moderator escalating a
 * temporary ban to a permanent one changed nothing. The active ban is now
 * updated in place (`created: false`, with the `previous` values).
 *
 * Query-level unit tests against a recording fake client (no Postgres
 * needed); bans.integration.test.ts runs the real queries when
 * TEST_DATABASE_URL is set.
 */
import { describe, expect, it } from 'vitest';
import { banUser, type ServerBanRow } from '../queries/bans.js';

interface Step {
  op: string;
  args: unknown[];
}

/**
 * A transaction whose every awaited query chain takes the next queued
 * result, recording what was called on it.
 */
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
  const tx = {
    select: (...args: unknown[]) => start('select', args),
    insert: (...args: unknown[]) => start('insert', args),
    update: (...args: unknown[]) => start('update', args),
    delete: (...args: unknown[]) => start('delete', args),
  };
  const db = { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never;
  return { db, chains };
}

const SERVER = '11111111-1111-4111-8111-111111111111';
const OWNER = '44444444-4444-4444-8444-444444444444';
const TARGET = '55555555-5555-4555-8555-555555555555';
const MOD = '33333333-3333-4333-8333-333333333333';
const OTHER_MOD = '66666666-6666-4666-8666-666666666666';

function banRow(overrides: Partial<ServerBanRow> = {}): ServerBanRow {
  return {
    id: 'ban-1',
    serverId: SERVER,
    userId: TARGET,
    bannedBy: OTHER_MOD,
    reason: 'spam',
    expiresAt: new Date(Date.now() + 60 * 60_000),
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

/** The values the chain's `.set(...)` received. */
function setValues(chain: Step[] | undefined): Record<string, unknown> {
  return (chain?.find((s) => s.op === 'set')?.args[0] ?? {}) as Record<string, unknown>;
}

describe('banUser — a second ban of an actively banned user', () => {
  it('updates the ban in place: new moderator, permanent when no expiry is given, the stored reason kept', async () => {
    const existing = banRow();
    const stored = banRow({ bannedBy: MOD, expiresAt: null });
    const { db, chains } = recordingDb([[{ ownerUserId: OWNER }], [existing], [stored], [], []]);
    const result = await banUser(db, { serverId: SERVER, userId: TARGET, bannedBy: MOD });
    expect(result).toEqual({
      ok: true,
      ban: stored,
      created: false,
      previous: { bannedBy: OTHER_MOD, reason: 'spam', expiresAt: existing.expiresAt },
    });
    const update = chains[2]!;
    expect(update[0]!.op).toBe('update');
    expect(setValues(update)).toEqual({ bannedBy: MOD, reason: 'spam', expiresAt: null });
    // The first ban's date stays: the user was banned on that day.
    expect(setValues(update)).not.toHaveProperty('createdAt');
    expect(chains.some((chain) => chain[0]!.op === 'insert')).toBe(false);
    // Any lingering membership is still removed.
    expect(chains.at(-1)![0]!.op).toBe('delete');
  });

  it('a new reason and expiry replace the old ones', async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const { db, chains } = recordingDb([[{ ownerUserId: OWNER }], [banRow()], [banRow({ reason: 'raid', expiresAt })], [], []]);
    const result = await banUser(db, { serverId: SERVER, userId: TARGET, bannedBy: MOD, reason: 'raid', expiresAt });
    expect(result.ok && result.created).toBe(false);
    expect(setValues(chains[2])).toEqual({ bannedBy: MOD, reason: 'raid', expiresAt });
  });

  it('a concurrent ban that won the insert is updated the same way', async () => {
    const winner = banRow();
    const { db, chains } = recordingDb([[{ ownerUserId: OWNER }], [], [], [winner], [banRow({ bannedBy: MOD, expiresAt: null })], [], []]);
    const result = await banUser(db, { serverId: SERVER, userId: TARGET, bannedBy: MOD });
    expect(result.ok && result.created).toBe(false);
    expect(chains.map((chain) => chain[0]!.op)).toEqual(['select', 'select', 'insert', 'select', 'update', 'update', 'delete']);
    expect(setValues(chains[4])).toEqual({ bannedBy: MOD, reason: 'spam', expiresAt: null });
  });
});

describe('banUser — a first ban', () => {
  it('inserts the ban: created', async () => {
    const stored = banRow({ bannedBy: MOD, reason: 'spam', expiresAt: null });
    const { db, chains } = recordingDb([[{ ownerUserId: OWNER }], [], [stored], [], []]);
    const result = await banUser(db, { serverId: SERVER, userId: TARGET, bannedBy: MOD, reason: 'spam' });
    expect(result).toEqual({ ok: true, ban: stored, created: true });
    expect(chains[2]![0]!.op).toBe('insert');
  });

  it('an expired ban row is refreshed as a new ban', async () => {
    const expired = banRow({ expiresAt: new Date(Date.now() - 60_000) });
    const stored = banRow({ bannedBy: MOD, reason: 'again', expiresAt: null });
    const { db, chains } = recordingDb([[{ ownerUserId: OWNER }], [expired], [stored], [], []]);
    const result = await banUser(db, { serverId: SERVER, userId: TARGET, bannedBy: MOD, reason: 'again' });
    expect(result).toEqual({ ok: true, ban: stored, created: true });
    expect(setValues(chains[2])).toMatchObject({ bannedBy: MOD, reason: 'again', expiresAt: null, createdAt: expect.any(Date) });
  });

  it('still refuses the owner and yourself', async () => {
    const { db } = recordingDb([[{ ownerUserId: TARGET }]]);
    expect(await banUser(db, { serverId: SERVER, userId: TARGET, bannedBy: MOD })).toEqual({ ok: false, error: 'cannot_ban_owner' });
    expect(await banUser(db, { serverId: SERVER, userId: MOD, bannedBy: MOD })).toEqual({ ok: false, error: 'cannot_ban_self' });
  });
});
