/**
 * Bots milestone (0037) against real Postgres:
 *   - one Welcome / Moderation bot per server (partial unique index),
 *     custom bots unlimited;
 *   - a bot message has user_id NULL + bot_id, and survives the bot's
 *     deletion with bot_id → NULL;
 *   - bots only reach text-like channels without a role gate;
 *   - the lobby auto-join gives the newcomer @everyone and says it joined.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDb } from '../client.js';
import {
  createBot,
  deleteBot,
  ensureBuiltInBot,
  getBotById,
  listBotAccessibleChannels,
  listBotsForServer,
  setBotTokenHash,
  touchBotLastUsed,
} from '../queries/bots.js';
import { createMessage, getMessageById } from '../queries/messages.js';
import { ensureServerMembershipDetailed } from '../queries/memberships.js';
import { getUserPermissions } from '../queries/roles.js';

const DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB_URL)('bots (integration)', () => {
  const sql = DB_URL ? postgres(DB_URL, { max: 1 }) : (null as unknown as postgres.Sql);
  const db = DB_URL ? createDb(DB_URL) : (null as unknown as ReturnType<typeof createDb>);

  const owner = randomUUID();
  const joiner = randomUUID();
  const serverId = randomUUID();
  const everyoneRoleId = randomUUID();
  const general = randomUUID();
  const gated = randomUUID();
  const voice = randomUUID();

  beforeAll(async () => {
    await sql`INSERT INTO users (id, display_name) VALUES (${owner}, 'Owner'), (${joiner}, 'Joiner')`;
    await sql`INSERT INTO servers (id, name, owner_user_id) VALUES (${serverId}, 'BotTest', ${owner})`;
    await sql`
      INSERT INTO roles (id, server_id, name, position, permissions)
      VALUES (${everyoneRoleId}, ${serverId}, '@everyone', 0, '["send_messages","read_message_history"]'::jsonb)`;
    await sql`
      INSERT INTO channels (id, server_id, name, type, position) VALUES
        (${general}, ${serverId}, 'general', 'text', 0),
        (${gated}, ${serverId}, 'staff', 'text', 1),
        (${voice}, ${serverId}, 'Lounge', 'voice', 2)`;
    await sql`INSERT INTO channel_role_overrides (channel_id, role_id) VALUES (${gated}, ${everyoneRoleId})`;
  });

  afterAll(async () => {
    await sql`DELETE FROM servers WHERE id = ${serverId}`;
    await sql`DELETE FROM users WHERE id IN (${owner}, ${joiner})`;
    await sql.end();
  });

  it('keeps one built-in bot per type per server, custom bots unlimited', async () => {
    const first = await ensureBuiltInBot(db, {
      serverId,
      name: 'Welcome Bot',
      type: 'welcome',
      permissions: ['send_messages'],
      createdBy: owner,
    });
    const second = await ensureBuiltInBot(db, {
      serverId,
      name: 'Another Welcome Bot',
      type: 'welcome',
      permissions: ['send_messages'],
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.bot.id).toBe(first.bot.id);
    expect(first.bot.createdByName).toBe('Owner');

    await expect(
      sql`INSERT INTO bots (server_id, name, type) VALUES (${serverId}, 'Dup', 'welcome')`
    ).rejects.toThrow();

    await createBot(db, { serverId, name: 'A', type: 'custom', permissions: [] });
    await createBot(db, { serverId, name: 'B', type: 'custom', permissions: [] });
    const all = await listBotsForServer(db, serverId);
    expect(all.filter((b) => b.type === 'custom')).toHaveLength(2);
    // Defaults from 0037: permissions is an array, settings an object.
    const [raw] = await sql`SELECT permissions, settings FROM bots WHERE server_id = ${serverId} AND name = 'A'`;
    expect(raw!.permissions).toEqual([]);
    expect(raw!.settings).toEqual({});
  });

  it('stores bot messages with bot_id and keeps them when the bot is deleted', async () => {
    const bot = await createBot(db, {
      serverId,
      name: 'Poster',
      type: 'custom',
      permissions: ['send_messages'],
      tokenHash: 'sha256$00',
    });
    expect(bot.tokenIssuedAt).not.toBeNull();
    const message = await createMessage(db, {
      channelId: general,
      userId: null,
      botId: bot.id,
      content: 'beep',
      metadata: { bot: { id: bot.id, name: bot.name, type: bot.type } },
    });
    expect(message.userId).toBeNull();
    expect(message.botId).toBe(bot.id);

    expect(await deleteBot(db, bot.id)).toBe(true);
    const kept = await getMessageById(db, message.id);
    expect(kept?.botId).toBeNull();
    expect((kept?.metadata.bot as { name?: string } | undefined)?.name).toBe('Poster');
  });

  it('rotates, revokes and throttles bot bookkeeping', async () => {
    const bot = await createBot(db, { serverId, name: 'Tokened', type: 'custom', permissions: [] });
    const rotated = await setBotTokenHash(db, bot.id, 'sha256$11');
    expect(rotated?.tokenHash).toBe('sha256$11');
    const revoked = await setBotTokenHash(db, bot.id, null);
    expect(revoked?.tokenHash).toBeNull();
    expect(revoked?.tokenIssuedAt).toBeNull();

    const t0 = new Date();
    await touchBotLastUsed(db, bot.id, t0);
    await touchBotLastUsed(db, bot.id, new Date(t0.getTime() + 1_000));
    const touched = await getBotById(db, bot.id);
    expect(touched?.lastUsedAt?.getTime()).toBe(t0.getTime());
  });

  it('only lets bots reach open text channels', async () => {
    const channels = await listBotAccessibleChannels(db, serverId);
    expect(channels.map((c) => c.id)).toEqual([general]);
  });

  it('auto-join gives @everyone and reports a real join once', async () => {
    const first = await ensureServerMembershipDetailed(db, serverId, joiner);
    const again = await ensureServerMembershipDetailed(db, serverId, joiner);
    expect(first?.created).toBe(true);
    expect(again?.created).toBe(false);
    expect(await getUserPermissions(db, joiner, serverId)).toEqual(
      expect.arrayContaining(['send_messages', 'read_message_history'])
    );
    // The display role stays empty — seedDefaultRoles owns it for the owner.
    expect(first?.membership.roleId).toBeNull();
  });
});
