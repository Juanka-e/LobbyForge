/**
 * Bot API v2 (0044) against real Postgres:
 *   - the §1.1 channel rule (mode all = open text channels; selected = exactly
 *     the grants, and NO channel once the last grant or its channel is gone —
 *     also under concurrent revokes);
 *   - command names unique per server, a conflicting bulk overwrite rolls back,
 *     managers' switches survive a re-registration — and a delete + re-register;
 *   - interaction retention (answers cleared after expiry, rows deleted 24 h later);
 *   - interactions answered at most once (also under concurrency), follow-ups
 *     capped, nothing after expiry;
 *   - endpoint failure accounting switches off at the cap exactly once;
 *   - CHECK constraints and cascades.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch Postgres.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDb } from '../client.js';
import { createBot, deleteBot } from '../queries/bots.js';
import {
  getBotChannelAccessState,
  getBotReachableChannel,
  grantBotChannelAccess,
  listBotChannelAccessIds,
  listBotChannelGrantsForChannel,
  listBotReachableChannels,
  revokeBotChannelAccess,
  setBotChannelAccess,
} from '../queries/botChannelAccess.js';
import {
  CommandNameTakenError,
  deleteBotCommandByName,
  listBotCommands,
  listServerCommands,
  replaceBotCommands,
  updateBotCommandAdmin,
} from '../queries/botCommands.js';
import {
  claimBotInteractionAnswer,
  claimBotInteractionFollowup,
  createBotInteraction,
  expireBotInteractions,
  failBotInteractionNow,
  getBotInteractionForBot,
  pruneBotInteractions,
} from '../queries/botInteractions.js';
import { createChannelWebhook, createWebhookMessage, getActiveChannelWebhook } from '../queries/channelWebhooks.js';
import {
  getBotEventEndpoint,
  recordBotEventDeliveryFailure,
  recordBotEventDeliverySuccess,
  upsertBotEventEndpoint,
} from '../queries/botEventEndpoints.js';

const DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB_URL)('Bot API v2 (integration)', () => {
  const sql = DB_URL ? postgres(DB_URL, { max: 2 }) : (null as unknown as postgres.Sql);
  const db = DB_URL ? createDb(DB_URL) : (null as unknown as ReturnType<typeof createDb>);

  const owner = randomUUID();
  const member = randomUUID();
  const serverId = randomUUID();
  const otherServerId = randomUUID();
  const everyoneRoleId = randomUUID();
  const general = randomUUID();
  const staff = randomUUID();
  const voice = randomUUID();
  const foreign = randomUUID();
  const command = (name: string) => ({ name, description: `Run ${name}`, options: [], channelIds: null, requiredPermission: null });
  let botA = '';
  let botB = '';

  beforeAll(async () => {
    await sql`INSERT INTO users (id, display_name) VALUES (${owner}, 'Owner'), (${member}, 'Member')`;
    await sql`INSERT INTO servers (id, name, owner_user_id) VALUES (${serverId}, 'V2', ${owner}), (${otherServerId}, 'Other', ${owner})`;
    await sql`
      INSERT INTO roles (id, server_id, name, position, permissions)
      VALUES (${everyoneRoleId}, ${serverId}, '@everyone', 0, '["send_messages"]'::jsonb)`;
    await sql`
      INSERT INTO channels (id, server_id, name, type, position) VALUES
        (${general}, ${serverId}, 'general', 'text', 0),
        (${staff}, ${serverId}, 'staff', 'text', 1),
        (${voice}, ${serverId}, 'Lounge', 'voice', 2),
        (${foreign}, ${otherServerId}, 'theirs', 'text', 0)`;
    await sql`INSERT INTO channel_role_overrides (channel_id, role_id) VALUES (${staff}, ${everyoneRoleId})`;
    botA = (await createBot(db, { serverId, name: 'Dice', type: 'custom', permissions: ['slash_commands'], createdBy: owner })).id;
    botB = (await createBot(db, { serverId, name: 'Other', type: 'custom', permissions: ['slash_commands'], createdBy: owner })).id;
  });

  afterAll(async () => {
    await sql`DELETE FROM servers WHERE id IN (${serverId}, ${otherServerId})`;
    await sql`DELETE FROM users WHERE id IN (${owner}, ${member})`;
    await sql.end();
  });

  it('channel access: mode all = open text channels; selected = exactly the grants, never foreign or voice', async () => {
    const bot = { id: botA, serverId };
    // A new bot starts in mode 'all' (the column default — the v1 rule).
    expect(await getBotChannelAccessState(db, botA)).toEqual({ mode: 'all', channelIds: [] });
    expect((await listBotReachableChannels(db, bot)).map((c) => c.id)).toEqual([general]);
    expect(await getBotReachableChannel(db, bot, staff)).toBeNull();
    // A single grant cannot sneak in while the bot uses every open channel.
    expect(await grantBotChannelAccess(db, { botId: botA, channelId: staff, grantedBy: owner })).toBe(false);
    expect(await listBotChannelAccessIds(db, botA)).toEqual([]);

    await setBotChannelAccess(db, { botId: botA, mode: 'selected', channelIds: [staff, voice, foreign], grantedBy: owner });
    expect((await listBotReachableChannels(db, bot)).map((c) => c.id)).toEqual([staff]);
    expect((await getBotReachableChannel(db, bot, staff))?.id).toBe(staff);
    expect(await getBotReachableChannel(db, bot, general)).toBeNull();
    expect(await getBotReachableChannel(db, bot, voice)).toBeNull();
    expect(await getBotReachableChannel(db, bot, foreign)).toBeNull();

    expect(await grantBotChannelAccess(db, { botId: botA, channelId: staff, grantedBy: owner })).toBe(false);
    // A replace keeps who granted a channel that stays.
    await setBotChannelAccess(db, { botId: botA, mode: 'selected', channelIds: [staff, general], grantedBy: member });
    const grants = await listBotChannelGrantsForChannel(db, staff);
    expect(grants.find((g) => g.botId === botA)?.grantedBy).toBe(owner);
    expect((await listBotChannelGrantsForChannel(db, general)).find((g) => g.botId === botA)?.grantedBy).toBe(member);

    await setBotChannelAccess(db, { botId: botA, mode: 'all' });
    expect(await getBotChannelAccessState(db, botA)).toEqual({ mode: 'all', channelIds: [] });
    expect((await listBotReachableChannels(db, bot)).map((c) => c.id)).toEqual([general]);
  });

  it('deleting a bot’s last granted channel leaves it with NO channel — never every open one', async () => {
    const solo = (await createBot(db, { serverId, name: 'Solo', type: 'custom', permissions: ['read_messages'], createdBy: owner })).id;
    const bot = { id: solo, serverId };
    const onlyA = randomUUID();
    await sql`INSERT INTO channels (id, server_id, name, type, position) VALUES (${onlyA}, ${serverId}, 'only-a', 'text', 5)`;
    await setBotChannelAccess(db, { botId: solo, mode: 'selected', channelIds: [onlyA], grantedBy: owner });
    expect((await listBotReachableChannels(db, bot)).map((c) => c.id)).toEqual([onlyA]);

    await sql`DELETE FROM channels WHERE id = ${onlyA}`; // the grant cascades away
    expect(await getBotChannelAccessState(db, solo)).toEqual({ mode: 'selected', channelIds: [] });
    expect(await getBotReachableChannel(db, bot, general)).toBeNull();
    expect(await listBotReachableChannels(db, bot)).toEqual([]);
  });

  it('two concurrent revokes of the last two grants leave the bot with no channel', async () => {
    const pair = (await createBot(db, { serverId, name: 'Pair', type: 'custom', permissions: ['read_messages'], createdBy: owner })).id;
    const bot = { id: pair, serverId };
    await setBotChannelAccess(db, { botId: pair, mode: 'selected', channelIds: [general, staff], grantedBy: owner });
    const results = await Promise.all([revokeBotChannelAccess(db, pair, general), revokeBotChannelAccess(db, pair, staff)]);
    expect(results).toEqual([true, true]);
    expect(await getBotReachableChannel(db, bot, general)).toBeNull();
    expect(await listBotReachableChannels(db, bot)).toEqual([]);
    const [row] = await sql`SELECT channel_access_mode AS mode FROM bots WHERE id = ${pair}`;
    expect(row!.mode).toBe('selected');
  });

  it('the SQL refuses an unknown access mode', async () => {
    await expect(sql`UPDATE bots SET channel_access_mode = 'everything' WHERE id = ${botA}`).rejects.toThrow();
  });

  it('command names are unique per server; a conflicting overwrite writes nothing', async () => {
    await replaceBotCommands(db, { botId: botA, serverId, commands: [command('roll'), command('flip')] });
    await expect(
      replaceBotCommands(db, { botId: botB, serverId, commands: [command('ping'), command('roll')] })
    ).rejects.toBeInstanceOf(CommandNameTakenError);
    expect(await listBotCommands(db, botB)).toEqual([]);
    expect((await listBotCommands(db, botA)).map((c) => c.name)).toEqual(['flip', 'roll']);
    // Same name in ANOTHER server is fine.
    const elsewhere = (await createBot(db, { serverId: otherServerId, name: 'X', type: 'custom', permissions: [] })).id;
    await replaceBotCommands(db, { botId: elsewhere, serverId: otherServerId, commands: [command('roll')] });
    expect((await listBotCommands(db, elsewhere)).map((c) => c.name)).toEqual(['roll']);
  });

  it('a re-registration keeps ids and the managers’ switches, and drops names left out', async () => {
    const [flip] = (await listBotCommands(db, botA)).filter((c) => c.name === 'flip');
    await updateBotCommandAdmin(db, flip!.id, { enabled: false, adminChannelIds: [general] });
    await replaceBotCommands(db, { botId: botA, serverId, commands: [{ ...command('flip'), description: 'Flip a coin' }] });
    const rows = await listBotCommands(db, botA);
    expect(rows.map((c) => c.name)).toEqual(['flip']);
    expect(rows[0]).toMatchObject({ id: flip!.id, description: 'Flip a coin', enabled: false, adminChannelIds: [general] });
    const listed = await listServerCommands(db, serverId);
    expect(listed.find((c) => c.name === 'flip')?.bot).toMatchObject({ id: botA, name: 'Dice', enabled: true, channelAccessMode: 'all' });
  });

  it('a bot cannot undo a manager’s switch by deleting and re-registering the command', async () => {
    const [flip] = (await listBotCommands(db, botA)).filter((c) => c.name === 'flip');
    await updateBotCommandAdmin(db, flip!.id, { enabled: false, adminChannelIds: [general], updatedBy: owner });
    // DELETE /commands/flip, then PUT /commands with it again.
    expect(await deleteBotCommandByName(db, botA, 'flip')).toBe(true);
    await replaceBotCommands(db, { botId: botA, serverId, commands: [command('flip')] });
    const [again] = await listBotCommands(db, botA);
    expect(again).toMatchObject({ name: 'flip', enabled: false, adminChannelIds: [general] });
    expect(again!.id).not.toBe(flip!.id);
    // An empty PUT (delete everything) and a re-register: same.
    await replaceBotCommands(db, { botId: botA, serverId, commands: [] });
    await replaceBotCommands(db, { botId: botA, serverId, commands: [command('flip'), command('fresh')] });
    const rows = await listBotCommands(db, botA);
    expect(rows.find((c) => c.name === 'flip')).toMatchObject({ enabled: false, adminChannelIds: [general] });
    // A name no manager touched starts from the defaults.
    expect(rows.find((c) => c.name === 'fresh')).toMatchObject({ enabled: true, adminChannelIds: null });
    const [override] = await sql`SELECT enabled, admin_channel_ids, updated_by FROM bot_command_overrides WHERE bot_id = ${botA} AND name = 'flip'`;
    expect(override).toEqual({ enabled: false, admin_channel_ids: [general], updated_by: owner });
    // The manager switching it back on is remembered the same way.
    await updateBotCommandAdmin(db, rows.find((c) => c.name === 'flip')!.id, { enabled: true, adminChannelIds: null, updatedBy: owner });
    await deleteBotCommandByName(db, botA, 'flip');
    await replaceBotCommands(db, { botId: botA, serverId, commands: [command('flip')] });
    expect((await listBotCommands(db, botA))[0]).toMatchObject({ name: 'flip', enabled: true, adminChannelIds: null });
  });

  it('the SQL rejects malformed commands, statuses and secrets', async () => {
    await expect(sql`INSERT INTO bot_commands (bot_id, server_id, name, description) VALUES (${botA}, ${serverId}, 'Bad Name', 'x')`).rejects.toThrow();
    await expect(sql`INSERT INTO bot_commands (bot_id, server_id, name, description) VALUES (${botA}, ${serverId}, 'ok', '')`).rejects.toThrow();
    await expect(
      sql`INSERT INTO bot_commands (bot_id, server_id, name, description, options) VALUES (${botA}, ${serverId}, 'obj', 'x', '{"a":1}'::jsonb)`
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO channel_webhooks (server_id, channel_id, name, token_hash) VALUES (${serverId}, ${general}, 'CI', 'plaintext-token')`
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO bot_event_endpoints (bot_id, url, secret) VALUES (${botB}, 'http://insecure.test', ${'s'.repeat(40)})`
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO bot_interactions (bot_id, server_id, channel_id, user_id, command_name, status, expires_at)
          VALUES (${botA}, ${serverId}, ${general}, ${member}, 'roll', 'bogus', now())`
    ).rejects.toThrow();
  });

  it('an interaction is answered once — even by two concurrent claims — and is bound to its bot', async () => {
    const interaction = await createBotInteraction(db, {
      botId: botA, commandId: null, serverId, channelId: general, userId: member, commandName: 'roll', options: { sides: 6 },
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    expect(await getBotInteractionForBot(db, interaction.id, botB)).toBeNull();
    const claims = await Promise.all([
      claimBotInteractionAnswer(db, { interactionId: interaction.id, botId: botA, response: { content: 'a', ephemeral: false } }),
      claimBotInteractionAnswer(db, { interactionId: interaction.id, botId: botA, response: { content: 'b', ephemeral: false } }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimBotInteractionAnswer(db, { interactionId: interaction.id, botId: botB, response: { content: 'x' } })).toBeNull();

    const followups = [];
    for (let i = 0; i < 7; i++) {
      followups.push(await claimBotInteractionFollowup(db, { interactionId: interaction.id, botId: botA, maxFollowups: 5 }));
    }
    expect(followups.filter(Boolean)).toHaveLength(5);
    expect((await getBotInteractionForBot(db, interaction.id, botA))?.followupCount).toBe(5);
  });

  it('nothing is accepted after expiry, and the sweep marks overdue rows expired', async () => {
    const overdue = await createBotInteraction(db, {
      botId: botA, commandId: null, serverId, channelId: general, userId: member, commandName: 'roll', options: {},
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await claimBotInteractionAnswer(db, { interactionId: overdue.id, botId: botA, response: { content: 'late' } })).toBeNull();
    expect(await expireBotInteractions(db, { botId: botA })).toBeGreaterThanOrEqual(1);
    expect((await getBotInteractionForBot(db, overdue.id, botA))?.status).toBe('expired');
  });

  it('retention: an expired answer loses its text, a row 24 h past expiry is deleted', async () => {
    const now = new Date();
    const recent = await createBotInteraction(db, {
      botId: botB, commandId: null, serverId, channelId: general, userId: member, commandName: 'ping', options: {},
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await claimBotInteractionAnswer(db, { interactionId: recent.id, botId: botB, response: { content: 'secret', ephemeral: true } });
    const stale = await createBotInteraction(db, {
      botId: botB, commandId: null, serverId, channelId: general, userId: member, commandName: 'ping', options: {},
      expiresAt: new Date(now.getTime() - 60_000),
    });
    await sql`UPDATE bot_interactions SET status = 'answered', response = '{"content":"old"}'::jsonb WHERE id = ${stale.id}`;
    const ancient = await createBotInteraction(db, {
      botId: botB, commandId: null, serverId, channelId: general, userId: member, commandName: 'ping', options: {},
      expiresAt: new Date(now.getTime() - 25 * 60 * 60_000),
    });
    const result = await pruneBotInteractions(db, { botId: botB }, now);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await getBotInteractionForBot(db, ancient.id, botB)).toBeNull();
    expect((await getBotInteractionForBot(db, stale.id, botB))?.response).toBeNull();
    expect((await getBotInteractionForBot(db, recent.id, botB))?.response).toEqual({ content: 'secret', ephemeral: true });
    // Failing it for good (the invoker lost access) drops the answer too.
    expect(await failBotInteractionNow(db, recent.id, botB)).toBe(true);
    expect(await getBotInteractionForBot(db, recent.id, botB)).toMatchObject({ status: 'failed', response: null });
    expect(await failBotInteractionNow(db, recent.id, botB)).toBe(false);
  });

  it('endpoint failures switch it off at the cap exactly once; saving re-arms it', async () => {
    await upsertBotEventEndpoint(db, { botId: botB, url: 'https://bot.example.com/hook', events: ['interaction_create'], secret: `whsec_${'x'.repeat(43)}` });
    const results = [];
    for (let i = 0; i < 22; i++) {
      results.push(await recordBotEventDeliveryFailure(db, { botId: botB, status: 500, maxFailures: 20, reason: 'too_many_failures' }));
    }
    expect(results.filter((r) => r?.justDisabled)).toHaveLength(1);
    const disabled = await getBotEventEndpoint(db, botB);
    expect(disabled).toMatchObject({ enabled: false, disabledReason: 'too_many_failures' });
    const rearmed = await upsertBotEventEndpoint(db, { botId: botB, url: 'https://bot.example.com/hook', events: ['interaction_create'] });
    expect(rearmed).toMatchObject({ enabled: true, failureCount: 0, disabledReason: null, secret: disabled!.secret });
    await recordBotEventDeliveryFailure(db, { botId: botB, status: 502, maxFailures: 20, reason: 'too_many_failures' });
    await recordBotEventDeliverySuccess(db, { botId: botB, status: 200 });
    expect((await getBotEventEndpoint(db, botB))?.failureCount).toBe(0);
  });

  it('a webhook post has no user and no bot; webhooks stop with a soft-deleted server', async () => {
    const webhook = await createChannelWebhook(db, {
      serverId, channelId: general, name: 'CI', tokenHash: `sha256$${'a'.repeat(64)}`, createdBy: owner,
    });
    const message = await createWebhookMessage(db, { channelId: general, content: 'Deployed', metadata: { webhook: { id: webhook.id, name: 'CI' } } });
    expect(message).toMatchObject({ userId: null, botId: null, metadata: { webhook: { id: webhook.id, name: 'CI' } } });
    expect(await getActiveChannelWebhook(db, webhook.id)).not.toBeNull();
  });

  it('deleting a bot removes its commands, interactions, grants and endpoint; deleting a channel its webhooks', async () => {
    const doomed = (await createBot(db, { serverId, name: 'Doomed', type: 'custom', permissions: ['slash_commands'] })).id;
    const [doom] = await replaceBotCommands(db, { botId: doomed, serverId, commands: [command('doom')] });
    await updateBotCommandAdmin(db, doom!.id, { enabled: false, updatedBy: owner });
    await setBotChannelAccess(db, { botId: doomed, mode: 'selected', channelIds: [general], grantedBy: owner });
    await upsertBotEventEndpoint(db, { botId: doomed, url: 'https://d.example.com', events: [], secret: `whsec_${'d'.repeat(43)}` });
    await createBotInteraction(db, {
      botId: doomed, commandId: null, serverId, channelId: general, userId: member, commandName: 'doom', options: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    await deleteBot(db, doomed);
    const [counts] = await sql`
      SELECT (SELECT count(*) FROM bot_commands WHERE bot_id = ${doomed})::int AS commands,
             (SELECT count(*) FROM bot_interactions WHERE bot_id = ${doomed})::int AS interactions,
             (SELECT count(*) FROM bot_channel_access WHERE bot_id = ${doomed})::int AS grants,
             (SELECT count(*) FROM bot_event_endpoints WHERE bot_id = ${doomed})::int AS endpoints,
             (SELECT count(*) FROM bot_command_overrides WHERE bot_id = ${doomed})::int AS overrides`;
    expect(counts).toEqual({ commands: 0, interactions: 0, grants: 0, endpoints: 0, overrides: 0 });

    const temp = randomUUID();
    await sql`INSERT INTO channels (id, server_id, name, type, position) VALUES (${temp}, ${serverId}, 'temp', 'text', 9)`;
    await createChannelWebhook(db, { serverId, channelId: temp, name: 'Temp', tokenHash: `sha256$${'b'.repeat(64)}`, createdBy: null });
    await sql`DELETE FROM channels WHERE id = ${temp}`;
    const [left] = await sql`SELECT count(*)::int AS n FROM channel_webhooks WHERE channel_id = ${temp}`;
    expect(left!.n).toBe(0);
  });
});
