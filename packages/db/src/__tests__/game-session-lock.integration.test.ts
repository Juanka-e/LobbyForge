/**
 * The session write lock (withGameSessionWriteLock) against real Postgres.
 *
 * The final test pass had 8 players roll dice at once: the actions route
 * retried an optimistic CAS 3 times, so only 3–4 rolls applied and the rest
 * answered "409 too many concurrent actions". The route now runs read →
 * reduce → write under a transaction-scoped advisory lock on the session.
 *
 * Two clients (two connection pools) stand in for two web processes: the
 * in-memory queue is per pool, so between them only the advisory lock
 * serializes.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDb, type DbClient } from '../client.js';
import {
  createGameSession,
  GameSessionBusyError,
  gameSessionWriteLockKey,
  getGameSessionById,
  setGameSessionStateCAS,
  withGameSessionWriteLock,
} from '../queries/gameSessions.js';

const DB_URL = process.env.TEST_DATABASE_URL;

type Rolls = { rolls: string[] };

function revisionOf(row: unknown): number {
  return (row as { revision: number }).revision;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!DB_URL)('game session write lock (integration)', () => {
  const sql = DB_URL ? postgres(DB_URL, { max: 1 }) : (null as unknown as postgres.Sql);
  const dbA = DB_URL ? createDb(DB_URL) : (null as unknown as DbClient);
  const dbB = DB_URL ? createDb(DB_URL) : (null as unknown as DbClient);

  const owner = randomUUID();
  const serverId = randomUUID();
  const channelOne = randomUUID();
  const channelTwo = randomUUID();
  let sessionId = '';
  let otherSessionId = '';

  /** One "action": read under the lock, think for a moment, write through tx. */
  function roll(db: DbClient, player: string, id = sessionId): Promise<boolean> {
    return withGameSessionWriteLock(db, id, async (tx, row) => {
      if (!row) throw new Error('session vanished');
      const state = row.state as Rolls;
      await sleep(Math.random() * 4); // the reducer's latency
      const cas = await setGameSessionStateCAS(tx, id, revisionOf(row), { rolls: [...state.rolls, player] });
      return cas.ok;
    });
  }

  /** Advisory lock requests on this session's key that are still waiting. */
  async function waitingOnLock(): Promise<number> {
    const [row] = await sql`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
        AND objid = (hashtext(${gameSessionWriteLockKey(sessionId)})::bigint & 4294967295)::oid`;
    return Number(row!.n);
  }

  beforeAll(async () => {
    await sql`INSERT INTO users (id, display_name) VALUES (${owner}, 'Lock Owner')`;
    await sql`INSERT INTO servers (id, name, owner_user_id) VALUES (${serverId}, 'LockTest', ${owner})`;
    await sql`
      INSERT INTO channels (id, server_id, name, type) VALUES
        (${channelOne}, ${serverId}, 'dice', 'voice'),
        (${channelTwo}, ${serverId}, 'cards', 'voice')`;
    const base = { serverId, pluginId: 'dice-lock-test', createdBy: owner, state: { rolls: [] } };
    sessionId = (await createGameSession(dbA, { ...base, channelId: channelOne })).id;
    otherSessionId = (await createGameSession(dbA, { ...base, channelId: channelTwo })).id;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM servers WHERE id = ${serverId}`;
    await sql`DELETE FROM users WHERE id = ${owner}`;
    await sql.end();
    for (const db of [dbA, dbB]) await (db as unknown as { $client: postgres.Sql }).$client.end();
  });

  it('control: the same burst WITHOUT the lock loses writes to the revision check', async () => {
    const before = await getGameSessionById(dbA, sessionId);
    // Everyone reads first, then everyone writes: exactly one CAS can win.
    const reads = await Promise.all(Array.from({ length: 8 }, () => getGameSessionById(dbA, sessionId)));
    const writes = await Promise.all(
      reads.map((row, i) =>
        setGameSessionStateCAS(dbB, sessionId, revisionOf(row), { rolls: [...(row!.state as Rolls).rolls, `u${i}`] })
      )
    );
    expect(writes.filter((w) => w.ok)).toHaveLength(1);
    // Put the session back for the real test.
    await sql`UPDATE game_sessions SET state = ${sql.json(before!.state as postgres.JSONValue)} WHERE id = ${sessionId}`;
  });

  it('applies every one of 24 concurrent read → reduce → writes from two pools', async () => {
    const before = revisionOf(await getGameSessionById(dbA, sessionId));
    const players = Array.from({ length: 24 }, (_, i) => `p${i}`);

    const results = await Promise.all(players.map((p, i) => roll(i % 2 === 0 ? dbA : dbB, p)));

    expect(results).toEqual(Array(24).fill(true));
    const after = await getGameSessionById(dbA, sessionId);
    const rolls = (after!.state as Rolls).rolls;
    expect(rolls).toHaveLength(24);
    expect(new Set(rolls)).toEqual(new Set(players));
    expect(revisionOf(after)).toBe(before + 24);
  });

  it('queues a pool’s own writers in memory; another pool waits on the advisory lock', async () => {
    let releaseHolder!: () => void;
    const holding = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let entered!: () => void;
    const holderEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = withGameSessionWriteLock(dbA, sessionId, async () => {
      entered();
      await holding;
    });
    await holderEntered;

    // Same pool: they wait in memory, not on a pooled connection.
    const samePool = Array.from({ length: 5 }, (_, i) => roll(dbA, `same${i}`));
    await sleep(250);
    expect(await waitingOnLock()).toBe(0);

    // Another pool ("process"): its writer waits on the lock in Postgres.
    const otherPool = roll(dbB, 'other');
    let waiting = 0;
    for (let i = 0; i < 40 && waiting === 0; i++) {
      await sleep(50);
      waiting = await waitingOnLock();
    }
    expect(waiting).toBe(1);

    releaseHolder();
    await holder;
    expect(await Promise.all([...samePool, otherPool])).toEqual(Array(6).fill(true));
  });

  it('gives up with GameSessionBusyError after the lock timeout; other sessions are not blocked', async () => {
    let releaseHolder!: () => void;
    const holding = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let entered!: () => void;
    const holderEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = withGameSessionWriteLock(dbA, sessionId, async () => {
      entered();
      await holding;
    });
    await holderEntered;

    await expect(
      withGameSessionWriteLock(dbB, sessionId, async () => 'late', { lockTimeoutMs: 200 })
    ).rejects.toBeInstanceOf(GameSessionBusyError);
    // The lock is per session.
    await expect(
      withGameSessionWriteLock(dbB, otherSessionId, async () => 'free', { lockTimeoutMs: 200 })
    ).resolves.toBe('free');

    releaseHolder();
    await holder;
  });

  it('a throw inside the callback rolls its write back and frees the session', async () => {
    const before = await getGameSessionById(dbA, sessionId);
    await expect(
      withGameSessionWriteLock(dbB, sessionId, async (tx, row) => {
        await setGameSessionStateCAS(tx, sessionId, revisionOf(row), { rolls: ['never'] });
        throw new Error('reducer failed');
      })
    ).rejects.toThrow('reducer failed');

    const after = await getGameSessionById(dbA, sessionId);
    expect(after!.state).toEqual(before!.state);
    expect(revisionOf(after)).toBe(revisionOf(before));
    await expect(roll(dbA, 'after-failure')).resolves.toBe(true);
  });

  it('hands the callback null for a session that does not exist', async () => {
    await expect(withGameSessionWriteLock(dbA, randomUUID(), async (_tx, row) => row)).resolves.toBeNull();
  });
});
