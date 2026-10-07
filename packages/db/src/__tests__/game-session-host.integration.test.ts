/**
 * Host transfer and the one-open-session-per-channel rule, against real
 * Postgres.
 *
 *  - transferGameSessionHost is a compare-and-swap on the current host: of
 *    two requests that both decided to move hosting, one wins.
 *  - Two simultaneous starts in one channel: the second INSERT hits the
 *    partial unique index `game_sessions_channel_open_unique`, and Drizzle
 *    WRAPS the driver error — isPgUniqueViolation must still see it (the
 *    start route turns it into 409 `activity_exists`).
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDb, type DbClient } from '../client.js';
import { isPgUniqueViolation } from '../pg-errors.js';
import {
  createGameSession,
  endGameSession,
  getActiveGameSessionForChannel,
  getGameSessionById,
  transferGameSessionHost,
} from '../queries/gameSessions.js';

const DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB_URL)('game session host transfer + channel mutex (integration)', () => {
  const sql = DB_URL ? postgres(DB_URL, { max: 1 }) : (null as unknown as postgres.Sql);
  const db = DB_URL ? createDb(DB_URL) : (null as unknown as DbClient);

  const owner = randomUUID();
  const guest = randomUUID();
  const serverId = randomUUID();
  const channelId = randomUUID();
  const raceChannelId = randomUUID();
  let sessionId = '';

  beforeAll(async () => {
    await sql`INSERT INTO users (id, display_name) VALUES (${owner}, 'Host Owner'), (${guest}, 'Host Guest')`;
    await sql`INSERT INTO servers (id, name, owner_user_id) VALUES (${serverId}, 'HostTest', ${owner})`;
    await sql`
      INSERT INTO channels (id, server_id, name, type) VALUES
        (${channelId}, ${serverId}, 'games', 'voice'),
        (${raceChannelId}, ${serverId}, 'race', 'voice')`;
    sessionId = (
      await createGameSession(db, { serverId, channelId, pluginId: 'host-test', createdBy: owner, state: { n: 0 } })
    ).id;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM servers WHERE id = ${serverId}`;
    await sql`DELETE FROM users WHERE id IN (${owner}, ${guest})`;
    await sql.end();
    await (db as unknown as { $client: postgres.Sql }).$client.end();
  });

  it('moves hosting once: the second of two racing transfers finds the host already changed', async () => {
    const before = (await getGameSessionById(db, sessionId)) as unknown as { revision: number };
    const [a, b] = await Promise.all([
      transferGameSessionHost(db, sessionId, { fromUserId: owner, toUserId: guest }),
      transferGameSessionHost(db, sessionId, { fromUserId: owner, toUserId: guest }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const after = (await getGameSessionById(db, sessionId)) as unknown as { createdBy: string; revision: number };
    expect(after.createdBy).toBe(guest);
    expect(after.revision).toBe(before.revision + 1);
  });

  it('writes the plugin state in the same statement when given', async () => {
    const moved = await transferGameSessionHost(db, sessionId, { fromUserId: guest, toUserId: owner, state: { n: 1 } });
    expect(moved?.createdBy).toBe(owner);
    expect(moved?.state).toEqual({ n: 1 });
  });

  it('refuses an ended session', async () => {
    const other = await createGameSession(db, {
      serverId,
      channelId: raceChannelId,
      pluginId: 'host-test',
      createdBy: owner,
      state: {},
    });
    await endGameSession(db, other.id);
    await expect(transferGameSessionHost(db, other.id, { fromUserId: owner, toUserId: guest })).resolves.toBeNull();
  });

  it('a second open session in a channel is a unique violation, seen through the Drizzle wrapper', async () => {
    const input = { serverId, channelId: raceChannelId, pluginId: 'host-test', createdBy: owner, state: {} };
    const results = await Promise.allSettled([createGameSession(db, input), createGameSession(db, input)]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(isPgUniqueViolation(rejected[0]!.reason)).toBe(true);
    const open = await getActiveGameSessionForChannel(db, raceChannelId);
    expect(open).not.toBeNull();
  });
});
