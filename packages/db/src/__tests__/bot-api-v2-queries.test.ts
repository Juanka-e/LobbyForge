/**
 * Bot API v2 (0044) — query-level unit tests against a recording fake
 * client (no Postgres). The real-database behaviour (constraints, cascades,
 * concurrency of the conditional UPDATEs) is covered by
 * `bot-api-v2.integration.test.ts` when TEST_DATABASE_URL is set.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  getBotChannelAccessState,
  getBotReachableChannel,
  grantBotChannelAccess,
  listBotChannelAccessForServer,
  listBotReachableChannels,
  revokeBotChannelGrantsForChannel,
  setBotChannelAccess,
} from '../queries/botChannelAccess.js';
import { CommandNameTakenError, listServerCommands, replaceBotCommands, updateBotCommandAdmin } from '../queries/botCommands.js';
import {
  claimBotInteractionAnswer,
  claimBotInteractionFollowup,
  expireBotInteractions,
  failBotInteractionNow,
  getBotInteractionForBot,
  pruneBotInteractions,
} from '../queries/botInteractions.js';
import { createWebhookMessage } from '../queries/channelWebhooks.js';
import {
  listBotEventTargets,
  recordBotEventDeliveryFailure,
  upsertBotEventEndpoint,
} from '../queries/botEventEndpoints.js';

interface Step {
  op: string;
  args: unknown[];
}

/** A chainable stand-in for the Drizzle client; awaiting a chain yields the next queued result. */
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
  const db: Record<string, unknown> = {
    select: (...args: unknown[]) => start('select', args),
    selectDistinct: (...args: unknown[]) => start('selectDistinct', args),
    insert: (...args: unknown[]) => start('insert', args),
    update: (...args: unknown[]) => start('update', args),
    delete: (...args: unknown[]) => start('delete', args),
  };
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return { db: db as never, chains };
}

function stepArg(steps: Step[], op: string): unknown {
  return steps.find((s) => s.op === op)?.args[0];
}

function sqlOf(where: unknown): string {
  return new PgDialect().sqlToQuery(where as SQL).sql;
}

const BOT = { id: 'bot-1', serverId: 'srv-1' };
const NOW = new Date('2026-10-03T12:00:00Z');

function channel(id: string, overrides: Record<string, unknown> = {}) {
  return { id, serverId: 'srv-1', name: id, type: 'text', position: 0, pluginId: null, topic: null, createdAt: NOW, ...overrides };
}

/** The rows `getBotChannelAccessState` reads: the bot's mode LEFT JOIN its grants. */
const ALL = [{ mode: 'all', channelId: null }];
const selected = (...ids: string[]) =>
  ids.length ? ids.map((channelId) => ({ mode: 'selected', channelId })) : [{ mode: 'selected', channelId: null }];

describe('getBotReachableChannel — the §1.1 rule', () => {
  it('mode all: an open text channel of the bot’s server', async () => {
    // channel → mode + grants → role overrides (none)
    const { db } = recordingDb([[channel('general')], ALL, []]);
    expect((await getBotReachableChannel(db, BOT, 'general'))?.id).toBe('general');
  });

  it('mode all: a role-gated channel stays closed', async () => {
    const { db } = recordingDb([[channel('staff')], ALL, [{ id: 'override-1' }]]);
    expect(await getBotReachableChannel(db, BOT, 'staff')).toBeNull();
  });

  it('mode selected: exactly the granted channels — a gated one opens, an open one closes', async () => {
    const granted = recordingDb([[channel('staff')], selected('staff')]);
    expect((await getBotReachableChannel(granted.db, BOT, 'staff'))?.id).toBe('staff');
    const notGranted = recordingDb([[channel('general')], selected('staff')]);
    expect(await getBotReachableChannel(notGranted.db, BOT, 'general')).toBeNull();
  });

  it('mode selected with NO grants (its last channel was deleted): nothing — never the v1 rule', async () => {
    const { db, chains } = recordingDb([[channel('general')], selected()]);
    expect(await getBotReachableChannel(db, BOT, 'general')).toBeNull();
    // The role gate is not even consulted: "no rows" is not "all open channels".
    expect(chains).toHaveLength(2);
  });

  it('an unknown mode or a missing bot row reaches nothing', async () => {
    const weird = recordingDb([[channel('general')], [{ mode: 'everything', channelId: null }]]);
    expect(await getBotReachableChannel(weird.db, BOT, 'general')).toBeNull();
    const gone = recordingDb([[channel('general')], []]);
    expect(await getBotReachableChannel(gone.db, BOT, 'general')).toBeNull();
  });

  it('never another server’s channel or a voice channel, whatever the grants say', async () => {
    const foreign = recordingDb([[channel('theirs', { serverId: 'srv-2' })], selected('theirs')]);
    expect(await getBotReachableChannel(foreign.db, BOT, 'theirs')).toBeNull();
    const voice = recordingDb([[channel('lounge', { type: 'voice' })], selected('lounge')]);
    expect(await getBotReachableChannel(voice.db, BOT, 'lounge')).toBeNull();
    // Rejected before the grants are even read.
    expect(foreign.chains).toHaveLength(1);
  });

  it('an unknown channel is null', async () => {
    const { db } = recordingDb([[]]);
    expect(await getBotReachableChannel(db, BOT, 'nope')).toBeNull();
  });
});

describe('listBotReachableChannels', () => {
  it('mode selected: filters by the bot’s server and text-like types in SQL', async () => {
    const { db, chains } = recordingDb([selected('staff'), [channel('staff')]]);
    const rows = await listBotReachableChannels(db, BOT);
    expect(rows.map((c) => c.id)).toEqual(['staff']);
    const where = sqlOf(stepArg(chains[1]!, 'where'));
    expect(where).toContain('"channels"."server_id" = $1');
    expect(where).toContain('"channels"."type" in');
  });

  it('mode selected with no grants: [] — the open-channel query never runs', async () => {
    const { db, chains } = recordingDb([selected()]);
    expect(await listBotReachableChannels(db, BOT)).toEqual([]);
    expect(chains).toHaveLength(1);
  });

  it('mode all: every open text channel (the v1 query)', async () => {
    // mode → gated ids → channels
    const { db, chains } = recordingDb([ALL, [{ channelId: 'staff' }], [channel('general'), channel('staff')]]);
    expect((await listBotReachableChannels(db, BOT)).map((c) => c.id)).toEqual(['general']);
    expect(chains[1]![0]!.op).toBe('selectDistinct');
  });

  it('the mode and the grants come from one query; anything but "all" is selected', async () => {
    const { db, chains } = recordingDb([[{ mode: 'selected', channelId: 'a' }, { mode: 'selected', channelId: 'b' }]]);
    expect(await getBotChannelAccessState(db, 'bot-1')).toEqual({ mode: 'selected', channelIds: ['a', 'b'] });
    expect(chains).toHaveLength(1);
    expect(sqlOf(stepArg(chains[0]!, 'where'))).toContain('"bots"."id" = $1');
    const legacy = recordingDb([[{ mode: null, channelId: null }]]);
    expect(await getBotChannelAccessState(legacy.db, 'bot-1')).toEqual({ mode: 'selected', channelIds: [] });
  });

  it('groups a server’s grants per bot in one query', async () => {
    const { db, chains } = recordingDb([
      [
        { botId: 'a', channelId: 'c1' },
        { botId: 'a', channelId: 'c2' },
        { botId: 'b', channelId: 'c1' },
      ],
    ]);
    const map = await listBotChannelAccessForServer(db, 'srv-1');
    expect(map.get('a')).toEqual(['c1', 'c2']);
    expect(map.get('b')).toEqual(['c1']);
    expect(chains).toHaveLength(1);
  });

  it('selected: stores the mode, drops rows not in the list, inserts the rest keeping existing grants', async () => {
    const { db, chains } = recordingDb([[], [], []]);
    await setBotChannelAccess(db, { botId: 'bot-1', mode: 'selected', channelIds: ['c1', 'c1', 'c2'], grantedBy: 'u1' }, NOW);
    expect(chains.map((c) => c[0]!.op)).toEqual(['update', 'delete', 'insert']);
    expect(stepArg(chains[0]!, 'set')).toEqual({ channelAccessMode: 'selected' });
    expect(sqlOf(stepArg(chains[1]!, 'where'))).toContain('not in');
    expect((stepArg(chains[2]!, 'values') as unknown[]).length).toBe(2);
    // An existing grant keeps who made it.
    expect(chains[2]!.some((step) => step.op === 'onConflictDoNothing')).toBe(true);
  });

  it('all: stores the mode and deletes every row; selected with [] stores the mode and no rows (no channel)', async () => {
    const all = recordingDb([[], []]);
    await setBotChannelAccess(all.db, { botId: 'bot-1', mode: 'all' }, NOW);
    expect(all.chains.map((c) => c[0]!.op)).toEqual(['update', 'delete']);
    expect(stepArg(all.chains[0]!, 'set')).toEqual({ channelAccessMode: 'all' });
    const none = recordingDb([[], []]);
    await setBotChannelAccess(none.db, { botId: 'bot-1', mode: 'selected', channelIds: [], grantedBy: 'u1' }, NOW);
    expect(none.chains.map((c) => c[0]!.op)).toEqual(['update', 'delete']);
    expect(stepArg(none.chains[0]!, 'set')).toEqual({ channelAccessMode: 'selected' });
  });

  it('a single grant is written only while the (locked) bot is in selected mode', async () => {
    const ok = recordingDb([[{ mode: 'selected' }], [{ botId: 'bot-1' }]]);
    expect(await grantBotChannelAccess(ok.db, { botId: 'bot-1', channelId: 'c1', grantedBy: 'u1' }, NOW)).toBe(true);
    expect(ok.chains[0]!.some((step) => step.op === 'for' && step.args[0] === 'update')).toBe(true);
    const all = recordingDb([[{ mode: 'all' }]]);
    expect(await grantBotChannelAccess(all.db, { botId: 'bot-1', channelId: 'c1', grantedBy: 'u1' }, NOW)).toBe(false);
    expect(all.chains).toHaveLength(1);
  });

  it('drops several bots’ grants on one channel and reports who lost one', async () => {
    const { db, chains } = recordingDb([[{ botId: 'a' }]]);
    expect(await revokeBotChannelGrantsForChannel(db, 'c1', ['a', 'b'])).toEqual(['a']);
    const where = sqlOf(stepArg(chains[0]!, 'where'));
    expect(where).toContain('"bot_channel_access"."channel_id" = $1');
    expect(where).toContain('"bot_channel_access"."bot_id" in');
    const nothing = recordingDb([]);
    expect(await revokeBotChannelGrantsForChannel(nothing.db, 'c1', [])).toEqual([]);
    expect(nothing.chains).toHaveLength(0);
  });
});

describe('replaceBotCommands', () => {
  const command = { name: 'roll', description: 'Roll dice', options: [], channelIds: null, requiredPermission: null };

  it('upserts only this bot’s rows and never touches the managers’ switches', async () => {
    const { db, chains } = recordingDb([[], [{ id: 'cmd-1' }], []]);
    await replaceBotCommands(db, { botId: 'bot-1', serverId: 'srv-1', commands: [command] }, NOW);
    const insert = chains[1]!;
    const conflict = stepArg(insert, 'onConflictDoUpdate') as { set: Record<string, unknown>; setWhere: SQL };
    expect(Object.keys(conflict.set).sort()).toEqual(['channelIds', 'description', 'options', 'requiredPermission', 'updatedAt']);
    expect(sqlOf(conflict.setWhere)).toContain('"bot_id" = $1');
  });

  it('a newly inserted name starts from the managers’ override for (bot, name), not the defaults', async () => {
    const { db, chains } = recordingDb([[], [{ id: 'cmd-1' }], []]);
    await replaceBotCommands(db, { botId: 'bot-1', serverId: 'srv-1', commands: [command] }, NOW);
    const values = stepArg(chains[1]!, 'values') as Record<string, unknown>;
    const enabled = sqlOf(values.enabled);
    expect(enabled).toContain('coalesce((select "bot_command_overrides"."enabled" from "bot_command_overrides"');
    expect(enabled).toContain('"bot_command_overrides"."bot_id" = $1 and "bot_command_overrides"."name" = $2');
    expect(enabled).toMatch(/, true\)$/);
    expect(sqlOf(values.adminChannelIds)).toContain(
      'select "bot_command_overrides"."admin_channel_ids" from "bot_command_overrides"'
    );
  });

  it('throws CommandNameTakenError when another bot owns a name (nothing returned by the guarded upsert)', async () => {
    const { db } = recordingDb([[], []]);
    await expect(replaceBotCommands(db, { botId: 'bot-1', serverId: 'srv-1', commands: [command] }, NOW)).rejects.toBeInstanceOf(
      CommandNameTakenError
    );
  });

  it('an empty list deletes every command of the bot', async () => {
    const { db, chains } = recordingDb([[], []]);
    await replaceBotCommands(db, { botId: 'bot-1', serverId: 'srv-1', commands: [] }, NOW);
    expect(chains[0]![0]!.op).toBe('delete');
  });

  it('reads a non-array options / channel list defensively', async () => {
    const { db } = recordingDb([
      [
        {
          id: 'c', botId: 'b', serverId: 's', name: 'x', description: 'd', options: { evil: true }, channelIds: 'all',
          adminChannelIds: null, requiredPermission: null, enabled: true, createdAt: NOW, updatedAt: NOW,
          botName: 'B', botType: 'custom', botEnabled: true, botPermissions: { administrator: true }, botChannelAccessMode: 'ALL',
        },
      ],
    ]);
    const [row] = await listServerCommands(db, 's');
    expect(row!.options).toEqual([]);
    expect(row!.channelIds).toBeNull();
    expect(row!.bot.permissions).toEqual([]);
    // Only the exact 'all' widens; anything else narrows to the grants.
    expect(row!.bot.channelAccessMode).toBe('selected');
  });
});

describe('updateBotCommandAdmin — the managers’ switches outlive the row', () => {
  it('updates the row and upserts the resulting state into bot_command_overrides (bot, name), in one transaction', async () => {
    const { db, chains } = recordingDb([
      [{ botId: 'bot-1', name: 'roll', enabled: false, adminChannelIds: ['c1'] }],
      [],
      [
        {
          id: 'cmd-1', botId: 'bot-1', serverId: 's', name: 'roll', description: 'd', options: [], channelIds: null,
          adminChannelIds: ['c1'], requiredPermission: null, enabled: false, createdAt: NOW, updatedAt: NOW,
        },
      ],
    ]);
    const row = await updateBotCommandAdmin(db, 'cmd-1', { enabled: false, updatedBy: 'u1' }, NOW);
    expect(row).toMatchObject({ id: 'cmd-1', enabled: false, adminChannelIds: ['c1'] });
    expect(chains.map((c) => c[0]!.op)).toEqual(['update', 'insert', 'select']);
    expect(stepArg(chains[0]!, 'set')).toEqual({ updatedAt: NOW, enabled: false });
    expect(stepArg(chains[1]!, 'values')).toEqual({
      botId: 'bot-1', name: 'roll', enabled: false, adminChannelIds: ['c1'], updatedBy: 'u1', updatedAt: NOW,
    });
    const upsert = stepArg(chains[1]!, 'onConflictDoUpdate') as { set: Record<string, unknown> };
    expect(upsert.set).toEqual({ enabled: false, adminChannelIds: ['c1'], updatedBy: 'u1', updatedAt: NOW });
  });

  it('an unknown command writes no override', async () => {
    const { db, chains } = recordingDb([[]]);
    expect(await updateBotCommandAdmin(db, 'nope', { enabled: false }, NOW)).toBeNull();
    expect(chains).toHaveLength(1);
  });
});

describe('interactions — conditional, bot-bound updates', () => {
  it('a lookup is bound to the bot', async () => {
    const { db, chains } = recordingDb([[]]);
    expect(await getBotInteractionForBot(db, 'i-1', 'other-bot')).toBeNull();
    const where = sqlOf(stepArg(chains[0]!, 'where'));
    expect(where).toContain('"bot_interactions"."id" = $1');
    expect(where).toContain('"bot_interactions"."bot_id" = $2');
  });

  it('the answer claim requires pending + unexpired + this bot', async () => {
    const { db, chains } = recordingDb([[]]);
    expect(await claimBotInteractionAnswer(db, { interactionId: 'i', botId: 'b', response: { content: 'x' } }, NOW)).toBeNull();
    const where = sqlOf(stepArg(chains[0]!, 'where'));
    expect(where).toMatch(/"status" = \$\d/);
    expect(where).toMatch(/"expires_at" > \$\d/);
    expect(where).toMatch(/"bot_id" = \$\d/);
  });

  it('a follow-up requires answered + unexpired + below the cap', async () => {
    const { db, chains } = recordingDb([[]]);
    await claimBotInteractionFollowup(db, { interactionId: 'i', botId: 'b', maxFollowups: 5 }, NOW);
    const where = sqlOf(stepArg(chains[0]!, 'where'));
    expect(where).toMatch(/"followup_count" < \$\d/);
    expect(where).toMatch(/"expires_at" > \$\d/);
  });

  it('failing an interaction for good (invoker lost access) also drops its stored answer', async () => {
    const { db, chains } = recordingDb([[{ id: 'i' }]]);
    expect(await failBotInteractionNow(db, 'i', 'b')).toBe(true);
    expect(stepArg(chains[0]!, 'set')).toEqual({ status: 'failed', response: null });
    const where = sqlOf(stepArg(chains[0]!, 'where'));
    expect(where).toMatch(/"bot_id" = \$\d/);
    expect(where).toMatch(/"status" in \(\$\d, \$\d\)/);
  });

  it('retention: clears answers of expired rows and deletes rows 24 h past expiry, one bot at a time', async () => {
    const { db, chains } = recordingDb([[{ id: 'a' }], [{ id: 'b' }, { id: 'c' }]]);
    expect(await pruneBotInteractions(db, { botId: 'bot-1' }, NOW)).toEqual({ cleared: 1, deleted: 2 });
    expect(chains.map((c) => c[0]!.op)).toEqual(['update', 'delete']);
    expect(stepArg(chains[0]!, 'set')).toEqual({ response: null });
    const clearWhere = new PgDialect().sqlToQuery(stepArg(chains[0]!, 'where') as SQL);
    expect(clearWhere.sql).toMatch(/"expires_at" <= \$\d/);
    expect(clearWhere.sql).toContain('"response" is not null');
    const deleteWhere = new PgDialect().sqlToQuery(stepArg(chains[1]!, 'where') as SQL);
    expect(deleteWhere.sql).toMatch(/"bot_id" = \$1 and "bot_interactions"."expires_at" < \$2/);
    expect(deleteWhere.params[1]).toBe(new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString());
  });

  it('the sweep only expires overdue pending rows (optionally one bot’s)', async () => {
    const { db, chains } = recordingDb([[{ id: 'a' }, { id: 'b' }]]);
    expect(await expireBotInteractions(db, { botId: 'b' }, NOW)).toBe(2);
    expect(stepArg(chains[0]!, 'set')).toEqual({ status: 'expired' });
    const where = sqlOf(stepArg(chains[0]!, 'where'));
    expect(where).toMatch(/"expires_at" <= \$\d/);
    expect(where).toMatch(/"bot_id" = \$\d/);
  });
});

describe('event endpoints', () => {
  it('a new endpoint needs a secret; a replace without one keeps the stored secret', async () => {
    const empty = recordingDb([[]]);
    await expect(upsertBotEventEndpoint(empty.db, { botId: 'b', url: 'https://x.test', events: [] }, NOW)).rejects.toThrow();
    const existing = { botId: 'b', url: 'https://old.test', secret: 'whsec_old'.padEnd(40, 'x'), events: [], enabled: false, failureCount: 20 };
    const { db, chains } = recordingDb([[existing], [{ ...existing, url: 'https://new.test', enabled: true, failureCount: 0 }]]);
    const row = await upsertBotEventEndpoint(db, { botId: 'b', url: 'https://new.test', events: ['interaction_create'] }, NOW);
    expect(row.enabled).toBe(true);
    const values = stepArg(chains[1]!, 'values') as Record<string, unknown>;
    expect(values.secret).toBe(existing.secret);
    expect(values.failureCount).toBe(0);
  });

  it('reports the failure that switched the endpoint off — once', async () => {
    const disabled = recordingDb([[{ botId: 'b', url: 'u', secret: 's', events: [], enabled: false, failureCount: 20 }]]);
    const first = await recordBotEventDeliveryFailure(disabled.db, { botId: 'b', status: 500, maxFailures: 20, reason: 'too_many_failures' }, NOW);
    expect(first?.justDisabled).toBe(true);
    const later = recordingDb([[{ botId: 'b', url: 'u', secret: 's', events: [], enabled: false, failureCount: 21 }]]);
    const second = await recordBotEventDeliveryFailure(later.db, { botId: 'b', status: 500, maxFailures: 20, reason: 'too_many_failures' }, NOW);
    expect(second?.justDisabled).toBe(false);
  });

  it('fan-out targets: enabled custom bots only, permissions read defensively', async () => {
    const { db, chains } = recordingDb([
      [
        { botId: 'a', botName: 'A', permissions: ['read_messages'], channelAccessMode: 'all', url: 'https://a.test', events: ['message_create'], endpointEnabled: true },
        { botId: 'b', botName: 'B', permissions: { administrator: true }, channelAccessMode: 'bogus', url: null, events: null, endpointEnabled: null },
      ],
    ]);
    const targets = await listBotEventTargets(db, 'srv-1');
    expect(targets[0]!.endpoint).toEqual({ url: 'https://a.test', events: ['message_create'], enabled: true });
    expect(targets[0]!.channelAccessMode).toBe('all');
    expect(targets[1]!.permissions).toEqual([]);
    expect(targets[1]!.channelAccessMode).toBe('selected');
    expect(targets[1]!.endpoint).toBeNull();
    const where = sqlOf(stepArg(chains[0]!, 'where'));
    expect(where).toMatch(/"bots"."type" = \$\d/);
    expect(where).toMatch(/"bots"."enabled" = \$\d/);
  });
});

describe('createWebhookMessage', () => {
  it('stores an author-less message (no user, no bot) with the webhook metadata', async () => {
    const { db, chains } = recordingDb([[{ id: 'ch' }], [{ id: 'm1', channelId: 'ch', userId: null, botId: null, content: 'hi', metadata: {} }]]);
    await createWebhookMessage(db, { channelId: 'ch', content: 'hi', metadata: { webhook: { id: 'w', name: 'CI' } } });
    const values = stepArg(chains[1]!, 'values') as Record<string, unknown>;
    expect(values.userId).toBeNull();
    expect(values.botId).toBeNull();
    expect(values.metadata).toEqual({ webhook: { id: 'w', name: 'CI' } });
  });

  it('refuses a channel whose server is gone', async () => {
    const { db } = recordingDb([[]]);
    await expect(createWebhookMessage(db, { channelId: 'ch', content: 'hi', metadata: {} })).rejects.toThrow(/does not exist/);
  });
});
