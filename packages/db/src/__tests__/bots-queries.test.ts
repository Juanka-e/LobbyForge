/**
 * Bots milestone — query-level unit tests against a recording fake client
 * (no Postgres needed). The real-database behaviour (partial unique index,
 * FK SET NULL, @everyone on auto-join) is covered by
 * `bots.integration.test.ts` when TEST_DATABASE_URL is set.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  deleteBot,
  ensureBuiltInBot,
  isBuiltInBotType,
  listBotAccessibleChannels,
  listBotsForServer,
  listUserDisplayNames,
  setBotTokenHash,
  touchBotLastUsed,
  updateBot,
} from '../queries/bots.js';
import { createMessage } from '../queries/messages.js';
import { ensureServerMembershipDetailed } from '../queries/memberships.js';

interface Step {
  op: string;
  args: unknown[];
}

/**
 * A chainable stand-in for the Drizzle client. Every top-level call
 * (select / insert / update / delete) records its method chain; awaiting
 * a chain resolves to the next queued result.
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
  const db = {
    select: (...args: unknown[]) => start('select', args),
    selectDistinct: (...args: unknown[]) => start('selectDistinct', args),
    insert: (...args: unknown[]) => start('insert', args),
    update: (...args: unknown[]) => start('update', args),
    delete: (...args: unknown[]) => start('delete', args),
  };
  return { db: db as never, chains };
}

function stepArg(steps: Step[], op: string): unknown {
  return steps.find((s) => s.op === op)?.args[0];
}

function renderWhere(where: unknown): string {
  return new PgDialect().sqlToQuery(where as SQL).sql;
}

const NOW = new Date('2026-09-28T12:00:00Z');

function botRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bot-1',
    serverId: 'srv-1',
    name: 'Helper',
    type: 'custom',
    tokenHash: null,
    tokenIssuedAt: null,
    permissions: ['send_messages'],
    settings: {},
    enabled: true,
    createdBy: 'user-1',
    createdByName: 'Owner',
    lastUsedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('bot rows', () => {
  it('never reads a non-array permissions value as a grant', async () => {
    const { db } = recordingDb([
      [
        botRow({ permissions: { administrator: true } }),
        botRow({ id: 'bot-2', permissions: ['read_messages', 42, null] }),
        botRow({ id: 'bot-3', settings: ['not', 'an', 'object'] }),
      ],
    ]);
    const rows = await listBotsForServer(db, 'srv-1');
    expect(rows[0]!.permissions).toEqual([]);
    expect(rows[1]!.permissions).toEqual(['read_messages']);
    expect(rows[2]!.settings).toEqual({});
    expect(rows[0]!.createdByName).toBe('Owner');
  });

  it('knows which bot types are built in', () => {
    expect(isBuiltInBotType('welcome')).toBe(true);
    expect(isBuiltInBotType('moderation')).toBe(true);
    expect(isBuiltInBotType('custom')).toBe(false);
    expect(isBuiltInBotType('administrator')).toBe(false);
  });
});

describe('setBotTokenHash', () => {
  it('stores the hash and stamps when the token was issued', async () => {
    const { db, chains } = recordingDb([[{ id: 'bot-1' }], [botRow({ tokenHash: 'sha256$ab' })]]);
    const row = await setBotTokenHash(db, 'bot-1', 'sha256$ab', NOW);
    expect(row?.tokenHash).toBe('sha256$ab');
    expect(stepArg(chains[0]!, 'set')).toEqual({ tokenHash: 'sha256$ab', tokenIssuedAt: NOW, updatedAt: NOW });
  });

  it('clears the issue date when the token is revoked', async () => {
    const { db, chains } = recordingDb([[{ id: 'bot-1' }], [botRow()]]);
    await setBotTokenHash(db, 'bot-1', null, NOW);
    expect(stepArg(chains[0]!, 'set')).toEqual({ tokenHash: null, tokenIssuedAt: null, updatedAt: NOW });
  });

  it('returns null for an unknown bot', async () => {
    const { db } = recordingDb([[]]);
    expect(await setBotTokenHash(db, 'nope', 'sha256$ab', NOW)).toBeNull();
  });
});

describe('updateBot / deleteBot', () => {
  it('only writes the fields it was given', async () => {
    const { db, chains } = recordingDb([[{ id: 'bot-1' }], [botRow({ enabled: false })]]);
    await updateBot(db, 'bot-1', { enabled: false }, NOW);
    expect(stepArg(chains[0]!, 'set')).toEqual({ enabled: false, updatedAt: NOW });
  });

  it('reports whether a row was deleted', async () => {
    expect(await deleteBot(recordingDb([[{ id: 'bot-1' }]]).db, 'bot-1')).toBe(true);
    expect(await deleteBot(recordingDb([[]]).db, 'bot-1')).toBe(false);
  });
});

describe('ensureBuiltInBot', () => {
  it('returns the existing bot without inserting', async () => {
    const { db, chains } = recordingDb([[botRow({ type: 'welcome' })]]);
    const result = await ensureBuiltInBot(db, {
      serverId: 'srv-1',
      name: 'Welcome Bot',
      type: 'welcome',
      permissions: ['send_messages'],
    });
    expect(result.created).toBe(false);
    expect(chains.some((c) => c[0]!.op === 'insert')).toBe(false);
  });

  it('inserts once, never with a token, and tolerates a concurrent insert', async () => {
    const { db, chains } = recordingDb([
      [],
      [{ id: 'bot-9' }],
      [botRow({ id: 'bot-9', type: 'moderation' })],
    ]);
    const result = await ensureBuiltInBot(
      db,
      {
        serverId: 'srv-1',
        name: 'Moderation Bot',
        type: 'moderation',
        permissions: ['moderate_messages'],
        tokenHash: 'sha256$should-be-ignored',
      },
      NOW
    );
    expect(result).toMatchObject({ created: true, bot: { id: 'bot-9' } });
    const insert = chains.find((c) => c[0]!.op === 'insert')!;
    expect(insert.some((s) => s.op === 'onConflictDoNothing')).toBe(true);
    expect(stepArg(insert, 'values')).toMatchObject({ tokenHash: null, tokenIssuedAt: null, type: 'moderation' });
  });
});

describe('touchBotLastUsed', () => {
  it('is throttled in SQL', async () => {
    const { db, chains } = recordingDb([[]]);
    await touchBotLastUsed(db, 'bot-1', NOW, 60_000);
    expect(stepArg(chains[0]!, 'set')).toEqual({ lastUsedAt: NOW });
    const where = renderWhere(stepArg(chains[0]!, 'where'));
    expect(where).toContain('"last_used_at" is null');
    expect(where).toContain('"last_used_at" <');
  });
});

describe('listBotAccessibleChannels', () => {
  it('drops role-gated channels', async () => {
    const { db } = recordingDb([
      [{ channelId: 'ch-private' }],
      [
        { id: 'ch-general', type: 'text' },
        { id: 'ch-private', type: 'text' },
        { id: 'ch-news', type: 'announcement' },
      ],
    ]);
    const rows = await listBotAccessibleChannels(db, 'srv-1');
    expect(rows.map((c) => c.id)).toEqual(['ch-general', 'ch-news']);
  });
});

describe('listUserDisplayNames', () => {
  it('skips the query for an empty list', async () => {
    const { db, chains } = recordingDb([]);
    expect((await listUserDisplayNames(db, [])).size).toBe(0);
    expect(chains).toHaveLength(0);
  });
});

describe('createMessage author rule', () => {
  it('refuses a message with both or neither author', async () => {
    const { db } = recordingDb([]);
    await expect(
      createMessage(db, { channelId: 'ch-1', userId: 'u-1', botId: 'bot-1', content: 'x' })
    ).rejects.toThrow(/exactly one/);
    await expect(createMessage(db, { channelId: 'ch-1', userId: null, content: 'x' })).rejects.toThrow(
      /exactly one/
    );
  });

  it('writes the bot id for a bot message', async () => {
    const { db, chains } = recordingDb([
      [{ id: 'ch-1' }],
      [{ id: 'm-1', channelId: 'ch-1', userId: null, botId: 'bot-1', content: 'hi' }],
    ]);
    const row = await createMessage(db, { channelId: 'ch-1', userId: null, botId: 'bot-1', content: 'hi' });
    expect(row.botId).toBe('bot-1');
    const insert = chains.find((c) => c[0]!.op === 'insert')!;
    expect(stepArg(insert, 'values')).toMatchObject({ userId: null, botId: 'bot-1' });
  });
});

describe('ensureServerMembershipDetailed', () => {
  it('gives a brand-new member the @everyone role and reports the join', async () => {
    const { db, chains } = recordingDb([
      [], // isCurrentlyBanned
      [], // getServerMember
      [{ ownerUserId: 'owner-1' }], // approval check: server owner (AUTHZ-004)
      [], // approval check: no access policy row
      [{ id: 'role-everyone' }], // @everyone lookup
      [], // no stored sanction (AUTHZ-002)
      [{ id: 'm-1', serverId: 'srv-1', userId: 'u-1', roleId: null }], // insert membership
      [], // insert membership_roles
    ]);
    const result = await ensureServerMembershipDetailed(db, 'srv-1', 'u-1');
    expect(result?.created).toBe(true);
    const inserts = chains.filter((c) => c[0]!.op === 'insert');
    // @everyone goes in the role set, not the display role (left for seedDefaultRoles).
    expect(stepArg(inserts[0]!, 'values')).toEqual({ serverId: 'srv-1', userId: 'u-1' });
    expect(stepArg(inserts[1]!, 'values')).toEqual({ membershipId: 'm-1', roleId: 'role-everyone' });
  });

  it('does not report a join for an existing member', async () => {
    const { db, chains } = recordingDb([[], [{ id: 'm-1', serverId: 'srv-1', userId: 'u-1' }]]);
    const result = await ensureServerMembershipDetailed(db, 'srv-1', 'u-1');
    expect(result?.created).toBe(false);
    expect(chains.some((c) => c[0]!.op === 'insert')).toBe(false);
  });

  it('refuses a banned user', async () => {
    const { db } = recordingDb([[{ id: 'ban-1', expiresAt: null }]]);
    expect(await ensureServerMembershipDetailed(db, 'srv-1', 'u-1')).toBeNull();
  });
});
