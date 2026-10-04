/**
 * A marketplace (worker-backed) plugin's `migrateState` is an RPC to the
 * plugin-worker and returns a Promise. The GET and actions routes used it
 * unawaited: the reducer received the Promise (serialized as `{}`), so
 * every action started from an empty state, and readers got `{}`.
 *
 * These tests drive the REAL routes, the REAL worker-backed plugin object
 * (plugin-worker-client buildWorkerPlugin) and the REAL callHandleAction,
 * with the worker's HTTP endpoint faked via a stubbed fetch and the
 * session row kept in memory. Official in-process plugins return plain
 * values; awaiting them changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';
import { registerGamePlugin, type RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';
import { pollPlugin } from '@lobbyforge/poll';

interface Row {
  id: string;
  serverId: string;
  channelId: string;
  pluginId: string;
  status: string;
  state: Record<string, unknown>;
  publicSummary: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  startedAt: Date | null;
  revision: number;
}

const store = vi.hoisted(() => ({ row: null as unknown as Row }));

const dbFns = vi.hoisted(() => ({
  getServerById: vi.fn(async () => ({ id: 'srv-1', ownerUserId: 'u-host' })),
  getGameSessionById: vi.fn(async () => structuredClone(store.row)),
  isServerMember: vi.fn(async () => true),
  getUserPermissions: vi.fn(async () => [] as string[]),
  listPlayersForSession: vi.fn(async () => [] as Array<{ userId: string }>),
  addPlayerToSession: vi.fn(async () => undefined),
  logAction: vi.fn(async () => undefined),
  setGameSessionStateCAS: vi.fn(async (_db: unknown, _id: string, rev: number, state: Record<string, unknown>) => {
    if (rev !== store.row.revision) return { ok: false, row: structuredClone(store.row) };
    store.row = { ...store.row, state: structuredClone(state), revision: rev + 1 };
    return { ok: true, row: structuredClone(store.row) };
  }),
  users: { id: 'users.id', displayName: 'users.display_name' },
}));
vi.mock('@lobbyforge/db', () => dbFns);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDbClient: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));
vi.mock('@/lib/permissions', () => ({ authorizeSessionChannelVisibility: async () => ({ ok: true }) }));
vi.mock('@/lib/activity-bus', () => ({ publishActivityStateChange: vi.fn() }));
vi.mock('@/lib/activity-projection', () => ({ projectActivityState: (state: unknown) => state }));
vi.mock('@/lib/prepare-plugin-action', () => ({
  preparePluginAction: vi.fn(async (_db: unknown, input: { action: Record<string, unknown> }) => ({
    ok: true as const,
    action: input.action,
  })),
}));
vi.mock('@/lib/action-idempotency', () => ({
  claimActionId: vi.fn(),
  releaseActionId: vi.fn(),
  DuplicateActionError: class DuplicateActionError extends Error {},
  isValidActionId: () => false,
}));
// Real callHandleAction; only the DB-backed context builder is replaced.
vi.mock('@/lib/plugin-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plugin-context')>()),
  buildHttpPluginContext: vi.fn(async (input: { actorUserId: string; serverId: string; pluginId: string }) => {
    const ctx = createTestHarness({ plugin: pollPlugin, players: [input.actorUserId] }).context;
    Object.defineProperty(ctx, '__lfScope', { value: { serverId: input.serverId, pluginId: input.pluginId } });
    return ctx;
  }),
}));

const registry = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/plugin-server-registry', () => ({
  getPluginServer: (id: string) => registry.get(id) ?? null,
}));

const { buildWorkerPlugin } = await import('@/lib/plugin-worker-client');

const SECRET = 'x'.repeat(32);
const DIGEST = 'd'.repeat(64);

/** Every RPC body the fake worker received. */
const workerCalls: Array<Record<string, unknown>> = [];

/** The plugin-worker's /rpc, as a counter plugin with a v2 migration. */
async function fakeWorker(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  workerCalls.push(body);
  const raw = body.raw as Record<string, unknown>;
  const state = body.state as { count?: number; log?: string[] };
  const action = body.action as { type: string };
  let result: unknown;
  if (body.op === 'migrateState') result = { ...raw, schema: 2 };
  else if (body.op === 'handleAction') {
    result = { ...state, count: (state.count ?? 0) + 1, log: [...(state.log ?? []), action.type] };
  } else return new Response(JSON.stringify({ error: 'unexpected op' }), { status: 400 });
  return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function seedRow(pluginId: string, state: Record<string, unknown>): void {
  store.row = {
    id: 'sess-1',
    serverId: 'srv-1',
    channelId: 'ch-1',
    pluginId,
    status: 'running',
    state,
    publicSummary: {},
    createdBy: 'u-host',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    startedAt: null,
    revision: 3,
  };
}

function cookie(uid = 'u-host'): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest test' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

const params = { params: Promise.resolve({ id: 'srv-1', sessionId: 'sess-1' }) };

async function act(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import('../actions/route.js');
  const handler = POST as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  return handler(
    new Request('http://localhost/api/servers/srv-1/activities/sess-1/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookie() },
      body: JSON.stringify(body),
    }),
    params
  );
}

async function read(): Promise<Response> {
  const { GET } = await import('../route.js');
  const handler = GET as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  return handler(
    new Request('http://localhost/api/servers/srv-1/activities/sess-1', { headers: { cookie: cookie() } }),
    params
  );
}

const handleActionCalls = () => workerCalls.filter((c) => c.op === 'handleAction');

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  vi.stubEnv('LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED', 'true');
  vi.stubEnv('LOBBYFORGE_PLUGIN_WORKER_URL', 'http://plugin-worker:7101');
  vi.stubEnv('LOBBYFORGE_PLUGIN_WORKER_TOKEN', 'worker-token');
  vi.stubGlobal('fetch', vi.fn(fakeWorker));
  workerCalls.length = 0;
  dbFns.setGameSessionStateCAS.mockClear();
  registry.clear();
  registry.set(
    'counter',
    buildWorkerPlugin({
      id: 'counter',
      name: 'Counter',
      version: '1.10.0',
      digest: DIGEST,
      sdk: 'sandbox-v1',
      actionPolicies: {},
      locales: ['en'],
      ui: false,
      hasValidateAction: false,
      hasProjection: false,
      hasMigrateState: true,
    })
  );
  registry.set('poll', registerGamePlugin(pollPlugin));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('worker-backed plugin: state survives between actions', () => {
  it('two actions build on each other (the reducer gets the migrated state, not {})', async () => {
    seedRow('counter', { count: 0, log: [] });

    const first = await act({ type: 'bump' });
    expect(first.status).toBe(200);
    const second = await act({ type: 'bump' });
    expect(second.status).toBe(200);

    expect(store.row.state).toEqual({ count: 2, log: ['bump', 'bump'], schema: 2 });
    const body = (await second.json()) as { activity: { state: unknown } };
    expect(body.activity.state).toEqual({ count: 2, log: ['bump', 'bump'], schema: 2 });

    // The second reducer call received the first action's result, migrated,
    // for exactly the installed version + digest.
    const calls = handleActionCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      pluginId: 'counter',
      version: '1.10.0',
      digest: DIGEST,
      state: { count: 1, log: ['bump'], schema: 2 },
    });
  });

  it('the CAS retry re-migrates the fresh row (awaited inside the loop)', async () => {
    seedRow('counter', { count: 0, log: [] });
    // Someone else commits first: revision 3 → 4 with count 5.
    dbFns.setGameSessionStateCAS.mockImplementationOnce(async () => {
      store.row = { ...store.row, state: { count: 5, log: ['other'] }, revision: 4 };
      return { ok: false, row: structuredClone(store.row) };
    });

    const res = await act({ type: 'bump' });
    expect(res.status).toBe(200);
    const calls = handleActionCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.state).toEqual({ count: 5, log: ['other'], schema: 2 });
    expect(store.row.state).toEqual({ count: 6, log: ['other', 'bump'], schema: 2 });
  });

  it('GET returns the migrated state, not {}', async () => {
    seedRow('counter', { count: 4, log: ['a'] });
    const res = await read();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activity: { state: unknown } };
    expect(body.activity.state).toEqual({ count: 4, log: ['a'], schema: 2 });
    expect(workerCalls.map((c) => c.op)).toEqual(['migrateState']);
  });
});

// Imports every official plugin cold; under a full parallel run that alone
// can pass vitest's 5 s default.
describe('official in-process plugins are unaffected', { timeout: 20_000 }, () => {
  it('poll: two actions through the route still build on each other', async () => {
    const ctx = createTestHarness({ plugin: pollPlugin, players: ['u-host'] }).context;
    seedRow('poll', pollPlugin.createInitialState(ctx) as unknown as Record<string, unknown>);

    expect((await act({ type: 'open-poll', question: 'Pizza?', options: ['Yes', 'No'] })).status).toBe(200);
    expect((await act({ type: 'vote', optionId: 'opt-1' })).status).toBe(200);

    const state = store.row.state as { phase: string; options: Array<{ id: string; votes: number }>; ballotBox: string[] };
    expect(state.phase).toBe('open');
    expect(state.options.find((o) => o.id === 'opt-1')?.votes).toBe(1);
    expect(state.ballotBox).toEqual(['u-host']);
    expect(workerCalls).toHaveLength(0);
  });

  it('every official migrateState returns a plain value, so `await` hands back the same object', async () => {
    const { PLUGINS } = await import('@/lib/plugin-registry');
    const withMigrators = PLUGINS.filter((p): p is RegisteredGamePlugin & { migrateState: (raw: unknown) => unknown } =>
      typeof p.migrateState === 'function'
    );
    expect(withMigrators.length).toBeGreaterThan(0);
    for (const plugin of withMigrators) {
      const ctx = createTestHarness({ plugin: plugin as never, players: ['u-host', 'u-2'] }).context;
      const migrated = plugin.migrateState(plugin.createInitialState(ctx));
      expect(typeof (migrated as { then?: unknown } | null)?.then, plugin.manifest.id).not.toBe('function');
      expect(await migrated, plugin.manifest.id).toBe(migrated);
    }
  });
});
