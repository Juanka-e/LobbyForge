import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * PUT /api/servers/{id}/bots/builtin/welcome — choosing the Welcome Bot's
 * channel. The route used to check the channel with a made-up bot
 * (`{ id: 'welcome' }`), so `getBotChannelAccessState` ran
 * `bots.id = 'welcome'` against a uuid column: Postgres answers 22P02
 * (invalid input syntax for type uuid) and the save was a 500.
 *
 * Nothing on that path is mocked away here: the REAL `@lobbyforge/db`
 * queries (`getBuiltInBotForServer`, `getBotReachableChannel`,
 * `getChannelOpenToBots`, `getBotChannelAccessState`,
 * `isChannelOpenToBots`) run through Drizzle's pg-proxy driver against a
 * tiny in-memory stand-in that answers like Postgres — including refusing a
 * non-uuid value for a uuid column. Only auth, the insert/update writes and
 * the audit log are stubbed.
 */

type Row = Record<string, unknown>;
interface Store {
  bots: Row[];
  bot_channel_access: Row[];
  channels: Row[];
  channel_role_overrides: Row[];
  users: Row[];
}

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const OTHER_SERVER = '99999999-9999-4999-8999-999999999999';
const OWNER = '44444444-4444-4444-8444-444444444444';
const GENERAL = '22222222-2222-4222-8222-222222222222';
const STAFF = '88888888-8888-4888-8888-888888888888';
const FOREIGN = '77777777-7777-4777-8777-777777777777';
const WELCOME_BOT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOW = '2026-10-01T00:00:00.000Z';

let store: Store;
const executed: Array<{ sql: string; params: unknown[] }> = [];

/** table name → its uuid columns (from the real schema), filled once the schema is loaded. */
const uuidColumns = new Map<string, Set<string>>();

async function loadSchemaColumns(): Promise<void> {
  if (uuidColumns.size > 0) return;
  const schema = (await vi.importActual('@lobbyforge/db')) as Record<string, unknown>;
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const uuids = new Set<string>();
    for (const column of Object.values(getTableColumns(value))) {
      if (column.columnType === 'PgUUID') uuids.add(column.name);
    }
    uuidColumns.set(getTableName(value), uuids);
  }
}

function invalidUuid(value: unknown): Error {
  return Object.assign(new Error(`invalid input syntax for type uuid: "${String(value)}"`), { code: '22P02' });
}

/**
 * Just enough of Postgres for the queries on this path: one FROM table, at
 * most one LEFT JOIN, AND-ed `col = $n` conditions, LIMIT. Anything else
 * throws, so a query this stand-in does not understand fails the test
 * instead of passing it silently.
 */
function runQuery(sql: string, params: unknown[]): unknown[][] {
  executed.push({ sql, params });
  const from = /\bfrom "(\w+)"/.exec(sql)?.[1];
  if (!from || !(from in store)) throw new Error(`stand-in: unsupported query: ${sql}`);
  const join = /\bleft join "(\w+)" on "(\w+)"\."(\w+)" = "(\w+)"\."(\w+)"/.exec(sql);
  const wherePart = /\bwhere (.*?)(?: order by | limit |$)/.exec(sql)?.[1] ?? '';
  const conditions = [...wherePart.matchAll(/(?:"(\w+)"\.)?"(\w+)" = \$(\d+)/g)].map((m) => ({
    table: m[1] ?? from,
    column: m[2]!,
    value: params[Number(m[3]) - 1],
  }));
  // Postgres parses every parameter for its column type first.
  for (const c of conditions) {
    if (uuidColumns.get(c.table)?.has(c.column) && !UUID.test(String(c.value))) throw invalidUuid(c.value);
  }
  const matches = (table: string, row: Row) =>
    conditions.filter((c) => c.table === table).every((c) => row[c.column] === c.value);
  type Joined = Record<string, Row | null>;
  let rows: Joined[] = (store[from as keyof Store] as Row[]).filter((r) => matches(from, r)).map((r) => ({ [from]: r }));
  if (join) {
    const [, joined, leftTable, leftCol, rightTable, rightCol] = join;
    const own = leftTable === joined ? { col: leftCol!, other: rightTable!, otherCol: rightCol! } : { col: rightCol!, other: leftTable!, otherCol: leftCol! };
    rows = rows.flatMap((r) => {
      const partners = (store[joined as keyof Store] as Row[]).filter((p) => p[own.col] === r[own.other]?.[own.otherCol]);
      return partners.length ? partners.map((p) => ({ ...r, [joined!]: p })) : [{ ...r, [joined!]: null }];
    });
  }
  const limit = /\blimit \$(\d+)/.exec(sql);
  if (limit) rows = rows.slice(0, Number(params[Number(limit[1]) - 1]));
  const selectList = /^select (.*?) from "/.exec(sql)?.[1];
  if (!selectList) throw new Error(`stand-in: unsupported select: ${sql}`);
  const fields = selectList.split(/, (?=")/).map((item) => {
    const m = /^(?:"(\w+)"\.)?"(\w+)"$/.exec(item.trim());
    if (!m) throw new Error(`stand-in: unsupported select item ${item}`);
    return { table: m[1] ?? from, column: m[2]! };
  });
  return rows.map((r) => fields.map((f) => r[f.table]?.[f.column] ?? null));
}

const fakeDb = drizzle(async (sql, params) => ({ rows: runQuery(sql, params) }));

const ensureBuiltInBot = vi.fn();
const updateBot = vi.fn();
const logAction = vi.fn();
vi.mock('@lobbyforge/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Auth (requireBotManager → authorizeServerPermission).
  getServerById: async () => ({ id: SERVER, name: 'Lobby', ownerUserId: OWNER }),
  isServerMember: async () => true,
  getUserPermissions: async () => ['administrator'],
  // Writes and the audit log.
  ensureBuiltInBot,
  updateBot,
  logAction,
}));
vi.mock('@/lib/db', () => ({ getDb: () => fakeDb }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  distributedRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: Date.now() + 1000 }),
}));
vi.mock('@/lib/mail/verification', () => ({ requireVerifiedEmail: async () => null }));

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Owner' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function put(body: unknown) {
  return new Request(`https://chat.example.test/api/servers/${SERVER}/bots/builtin/welcome`, {
    method: 'PUT',
    headers: { cookie: cookie(OWNER), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ id: SERVER, type: 'welcome' }) };

function channel(id: string, name: string, serverId = SERVER, type = 'text'): Row {
  return { id, server_id: serverId, name, type, position: 0, plugin_id: null, topic: null, created_at: NOW };
}

function welcomeBot(mode: 'all' | 'selected'): Row {
  return {
    id: WELCOME_BOT,
    server_id: SERVER,
    name: 'Welcome Bot',
    type: 'welcome',
    token_hash: null,
    token_issued_at: null,
    permissions: ['send_messages'],
    settings: {},
    enabled: true,
    created_by: OWNER,
    last_used_at: null,
    created_at: NOW,
    updated_at: NOW,
    channel_access_mode: mode,
  };
}

function botResult(settings: Record<string, unknown>) {
  return {
    id: WELCOME_BOT, serverId: SERVER, name: 'Welcome Bot', type: 'welcome', tokenHash: null, tokenIssuedAt: null,
    permissions: ['send_messages'], settings, enabled: true, createdBy: OWNER, createdByName: 'Owner',
    lastUsedAt: null, createdAt: new Date(NOW), updatedAt: new Date(NOW),
  };
}

beforeEach(async () => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  await loadSchemaColumns();
  executed.length = 0;
  store = {
    bots: [],
    bot_channel_access: [],
    // #staff is role-gated (a channel_role_overrides row); #theirs belongs to another server.
    channels: [channel(GENERAL, 'general'), channel(STAFF, 'staff'), channel(FOREIGN, 'theirs', OTHER_SERVER)],
    channel_role_overrides: [{ id: 'cro-1', channel_id: STAFF, role_id: '55555555-5555-4555-8555-555555555555' }],
    users: [{ id: OWNER, display_name: 'Owner' }],
  };
  for (const fn of [ensureBuiltInBot, updateBot, logAction]) fn.mockReset();
  logAction.mockResolvedValue(undefined);
  ensureBuiltInBot.mockImplementation(async (_db: unknown, input: { settings: Record<string, unknown> }) => ({
    bot: botResult(input.settings),
    created: store.bots.length === 0,
  }));
  updateBot.mockImplementation(async (_db: unknown, _id: string, patch: { settings?: Record<string, unknown> }) =>
    botResult(patch.settings ?? {})
  );
});

describe('the stand-in answers like Postgres', () => {
  it('a made-up bot id against bots.id is 22P02 — exactly what the old route triggered', async () => {
    const { getBotReachableChannel } = (await vi.importActual('@lobbyforge/db')) as typeof import('@lobbyforge/db');
    // Drizzle wraps the driver's error, as it does with postgres-js.
    await expect(getBotReachableChannel(fakeDb as never, { id: 'welcome', serverId: SERVER }, GENERAL)).rejects.toMatchObject({
      cause: { code: '22P02' },
    });
  });
});

describe('PUT /bots/builtin/welcome — the channel', () => {
  it('first save (no Welcome Bot yet): an open text channel of this server is accepted, and no bot id is queried', async () => {
    const { PUT } = await import('../builtin/[type]/route.js');
    const res = await PUT(put({ enabled: true, settings: { channelId: GENERAL } }), ctx);
    expect(res.status).toBe(200);
    expect(ensureBuiltInBot).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ settings: expect.objectContaining({ channelId: GENERAL }) }));
    // The real queries ran: the built-in lookup, the channel and its role gate.
    expect(executed.some((q) => /from "channels"/.test(q.sql))).toBe(true);
    expect(executed.some((q) => /from "channel_role_overrides"/.test(q.sql))).toBe(true);
    // 'welcome' is only ever a bot TYPE, never an id.
    expect(executed.every((q) => !q.params.includes('welcome') || /"type" = \$/.test(q.sql))).toBe(true);
  });

  it('first save: a role-gated, foreign or unknown channel is 400 invalid_channel — not a 500', async () => {
    const { PUT } = await import('../builtin/[type]/route.js');
    for (const channelId of [STAFF, FOREIGN, '12345678-1234-4234-8234-123456789012']) {
      const res = await PUT(put({ settings: { channelId } }), ctx);
      expect(res.status, channelId).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_channel' });
    }
    expect(ensureBuiltInBot).not.toHaveBeenCalled();
  });

  it('an existing Welcome Bot is checked with its own row: mode all → open channels only', async () => {
    store.bots.push(welcomeBot('all'));
    const { PUT } = await import('../builtin/[type]/route.js');
    expect((await PUT(put({ settings: { channelId: GENERAL } }), ctx)).status).toBe(200);
    expect((await PUT(put({ settings: { channelId: STAFF } }), ctx)).status).toBe(400);
    // The access lookup used the bot's real id.
    const access = executed.filter((q) => /"channel_access_mode"/.test(q.sql) && /left join "bot_channel_access"/.test(q.sql));
    expect(access.length).toBeGreaterThan(0);
    expect(access.every((q) => q.params[0] === WELCOME_BOT)).toBe(true);
  });

  it('an existing Welcome Bot in selected mode: exactly its granted channels (a granted private one too)', async () => {
    store.bots.push(welcomeBot('selected'));
    store.bot_channel_access.push({ bot_id: WELCOME_BOT, channel_id: STAFF, granted_by: OWNER, created_at: NOW });
    const { PUT } = await import('../builtin/[type]/route.js');
    expect((await PUT(put({ settings: { channelId: STAFF } }), ctx)).status).toBe(200);
    const notGranted = await PUT(put({ settings: { channelId: GENERAL } }), ctx);
    expect(notGranted.status).toBe(400);
    expect(await notGranted.json()).toMatchObject({ code: 'invalid_channel' });
  });
});
