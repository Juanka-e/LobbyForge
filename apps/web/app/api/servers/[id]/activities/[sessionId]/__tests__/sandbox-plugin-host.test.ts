/**
 * ADR-007 host integration: a marketplace (sandbox-v1) plugin behaves like
 * an official one on the activity routes.
 *
 *  - its manifest's actionPolicies apply: member actions work for any
 *    member, `actorFields` are overwritten with the caller, `joinsRoster`
 *    adds the caller, audit follows the policy, host actions stay host-only;
 *  - its validateAction (an RPC) runs on the normalised action before
 *    dispatch;
 *  - a reducer that returns its input (`unchanged` from the worker) is a
 *    refused action: no roster join, no audit;
 *  - every read is projected per viewer by its projectState — GET and the
 *    actions response — and a failed projection never falls back to the
 *    unprojected state.
 *
 * The REAL routes, the REAL worker-backed plugin object and the REAL
 * callHandleAction; the worker's /rpc is a fake behind a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';
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

const HOST = 'u-host';
const ALICE = 'u-alice';
const BOB = 'u-bob';

const store = vi.hoisted(() => ({ row: null as unknown as Row, roster: [] as string[] }));

const dbFns = vi.hoisted(() => ({
  getServerById: vi.fn(async () => ({ id: 'srv-1', ownerUserId: 'u-owner' })),
  getGameSessionById: vi.fn(async () => structuredClone(store.row)),
  isServerMember: vi.fn(async () => true),
  getUserPermissions: vi.fn(async () => [] as string[]),
  listPlayersForSession: vi.fn(async () => store.roster.map((userId) => ({ userId, status: 'active', score: 0 }))),
  addPlayerToSession: vi.fn(async (_db: unknown, _sessionId: string, userId: string) => {
    store.roster.push(userId);
  }),
  logAction: vi.fn(async () => undefined),
  setGameSessionStateCAS: vi.fn(async (_db: unknown, _id: string, rev: number, state: Record<string, unknown>) => {
    if (rev !== store.row.revision) return { ok: false, row: structuredClone(store.row) };
    store.row = { ...store.row, state: structuredClone(state), revision: rev + 1 };
    return { ok: true, row: structuredClone(store.row) };
  }),
  // The session's write lock hands its callback the row as it stands now.
  withGameSessionWriteLock: vi.fn(
    async (_db: unknown, _id: string, fn: (tx: unknown, row: unknown) => Promise<unknown>) =>
      fn({ __mockTx: true }, structuredClone(store.row))
  ),
  GameSessionBusyError: class GameSessionBusyError extends Error {},
  users: { id: 'users.id', displayName: 'users.display_name' },
}));
vi.mock('@lobbyforge/db', () => dbFns);
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    // GET's display-name join: select().from().where().orderBy()
    select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }),
  }),
}));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));
vi.mock('@/lib/permissions', () => ({ authorizeSessionChannelVisibility: async () => ({ ok: true }) }));
vi.mock('@/lib/activity-bus', () => ({ publishActivityStateChange: vi.fn() }));
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
vi.mock('@/lib/plugin-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plugin-context')>()),
  buildHttpPluginContext: vi.fn(async (input: { actorUserId: string; serverId: string; pluginId: string; pendingPlayerId?: string }) => {
    const players = [...store.roster, ...(input.pendingPlayerId ? [input.pendingPlayerId] : [])];
    const ctx = createTestHarness({ plugin: pollPlugin, players: players.length ? players : [input.actorUserId] }).context;
    Object.defineProperty(ctx, 'actorUserId', { value: input.actorUserId });
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
const DIGEST = 'e'.repeat(64);
const workerCalls: Array<Record<string, unknown>> = [];
const worker = { failProjection: false, failValidation: false };

/**
 * The plugin worker's /rpc for "secret-pick": players pick a colour in
 * secret, the host reveals. projectState shows each viewer only their own
 * pick until the reveal.
 */
async function fakeWorker(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  workerCalls.push(body);
  const reply = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  const state = (body.state ?? {}) as { picks?: Record<string, string>; revealed?: boolean };
  const action = (body.action ?? {}) as { type?: string; playerId?: string; choice?: unknown };
  switch (body.op) {
    case 'validateAction':
      if (worker.failValidation) return reply({ error: 'worker down' }, 500);
      return reply({ result: action.type === 'pick' && typeof action.choice !== 'string' ? 'Pick a colour.' : null });
    case 'handleAction':
      if (action.type === 'noop') return reply({ unchanged: true });
      if (action.type === 'pick') {
        return reply({ result: { ...state, picks: { ...(state.picks ?? {}), [String(action.playerId)]: String(action.choice) } } });
      }
      if (action.type === 'reveal') return reply({ result: { ...state, revealed: true } });
      return reply({ unchanged: true });
    case 'projectState': {
      if (worker.failProjection) return reply({ error: 'Plugin "secret-pick" failed: boom' }, 500);
      const picks = state.picks ?? {};
      const viewer = String(body.viewerId);
      if (state.revealed) return reply({ result: { revealed: true, picks } });
      return reply({ result: { revealed: false, pickCount: Object.keys(picks).length, myPick: picks[viewer] ?? null } });
    }
    default:
      return reply({ error: `unexpected op ${String(body.op)}` }, 400);
  }
}

const baseInfo = {
  version: '1.0.0',
  digest: DIGEST,
  sdk: 'sandbox-v1' as const,
  locales: ['en'],
  ui: true,
  hasMigrateState: false,
};

function seedRow(pluginId: string, state: Record<string, unknown>): void {
  store.row = {
    id: 'sess-1',
    serverId: 'srv-1',
    channelId: 'ch-1',
    pluginId,
    status: 'running',
    state,
    publicSummary: {},
    createdBy: HOST,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    startedAt: null,
    revision: 1,
  };
}

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: `g_${uid}`.padEnd(34, 'a'), uid, name: uid };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

const params = { params: Promise.resolve({ id: 'srv-1', sessionId: 'sess-1' }) };

async function act(uid: string, body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import('../actions/route.js');
  const handler = POST as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  return handler(
    new Request('http://localhost/api/servers/srv-1/activities/sess-1/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookie(uid) },
      body: JSON.stringify(body),
    }),
    params
  );
}

async function read(uid: string): Promise<Response> {
  const { GET } = await import('../route.js');
  const handler = GET as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  return handler(new Request('http://localhost/api/servers/srv-1/activities/sess-1', { headers: { cookie: cookie(uid) } }), params);
}

const callsOf = (op: string) => workerCalls.filter((c) => c.op === op);

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  vi.stubEnv('LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED', 'true');
  vi.stubEnv('LOBBYFORGE_PLUGIN_WORKER_URL', 'http://plugin-worker:7101');
  vi.stubEnv('LOBBYFORGE_PLUGIN_WORKER_TOKEN', 'worker-token');
  vi.stubGlobal('fetch', vi.fn(fakeWorker));
  workerCalls.length = 0;
  worker.failProjection = false;
  worker.failValidation = false;
  store.roster = [];
  for (const fn of [dbFns.addPlayerToSession, dbFns.logAction, dbFns.setGameSessionStateCAS, dbFns.getUserPermissions]) fn.mockClear();
  registry.clear();
  registry.set(
    'secret-pick',
    buildWorkerPlugin({
      ...baseInfo,
      id: 'secret-pick',
      name: 'Secret Pick',
      actionPolicies: {
        pick: { role: 'member', actorFields: ['playerId'], joinsRoster: true },
        noop: { role: 'member', actorFields: ['playerId'], joinsRoster: true },
        reveal: { role: 'host' },
      },
      hasValidateAction: true,
      hasProjection: true,
    })
  );
  registry.set(
    'open-board',
    buildWorkerPlugin({
      ...baseInfo,
      id: 'open-board',
      name: 'Open Board',
      actionPolicies: {},
      hasValidateAction: false,
      hasProjection: false,
    })
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('sandbox plugin: the manifest action policies apply', () => {
  it('a member action works for any member; actorFields overwrite a spoofed id; joinsRoster adds the caller; no audit', async () => {
    seedRow('secret-pick', { picks: {}, revealed: false });
    const res = await act(ALICE, { type: 'pick', choice: 'red', playerId: BOB });
    expect(res.status).toBe(200);
    // Validation and the reducer both saw the caller's id, not the spoofed one.
    expect((callsOf('validateAction')[0]!.action as { playerId: string }).playerId).toBe(ALICE);
    expect((callsOf('handleAction')[0]!.action as { playerId: string }).playerId).toBe(ALICE);
    expect(store.row.state.picks).toEqual({ [ALICE]: 'red' });
    expect(dbFns.addPlayerToSession).toHaveBeenCalledWith(expect.anything(), 'sess-1', ALICE);
    expect(dbFns.logAction).not.toHaveBeenCalled();
    // The sandbox ctx carried the session, its host and the actor.
    expect(callsOf('handleAction')[0]!.ctx).toMatchObject({ sessionId: 'sess-1', serverId: 'srv-1', hostId: HOST, actorId: ALICE });
  });

  it('a host action stays host-only (403 for a member without Start Activities), and an unlisted action defaults to host', async () => {
    seedRow('secret-pick', { picks: {}, revealed: false });
    expect((await act(ALICE, { type: 'reveal' })).status).toBe(403);
    expect((await act(ALICE, { type: 'explode' })).status).toBe(403);
    expect(callsOf('handleAction')).toHaveLength(0);
  });

  it('the host can run a host action, and it is audited (host default)', async () => {
    seedRow('secret-pick', { picks: { [ALICE]: 'red' }, revealed: false });
    const res = await act(HOST, { type: 'reveal' });
    expect(res.status).toBe(200);
    expect(store.row.state.revealed).toBe(true);
    expect(dbFns.logAction).toHaveBeenCalledTimes(1);
  });
});

describe('sandbox plugin: validateAction and refused actions', () => {
  it('validateAction rejects with a 400 before dispatch', async () => {
    seedRow('secret-pick', { picks: {}, revealed: false });
    const res = await act(ALICE, { type: 'pick', choice: 42 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Pick a colour.');
    expect(callsOf('handleAction')).toHaveLength(0);
    expect(dbFns.setGameSessionStateCAS).not.toHaveBeenCalled();
  });

  it('a worker failure during validation fails closed (500, nothing committed)', async () => {
    seedRow('secret-pick', { picks: {}, revealed: false });
    worker.failValidation = true;
    expect((await act(ALICE, { type: 'pick', choice: 'red' })).status).toBe(500);
    expect(dbFns.setGameSessionStateCAS).not.toHaveBeenCalled();
  });

  it('a reducer that returns its input is a refused action: no roster join, no audit', async () => {
    seedRow('secret-pick', { picks: {}, revealed: false });
    const res = await act(ALICE, { type: 'noop' });
    expect(res.status).toBe(200);
    expect(dbFns.addPlayerToSession).not.toHaveBeenCalled();
    expect(dbFns.logAction).not.toHaveBeenCalled();
    expect(store.row.state).toEqual({ picks: {}, revealed: false });
  });
});

describe('sandbox plugin: every read is projected per viewer', () => {
  it('GET: each viewer sees only their own pick; the projection gets the viewer and the session', async () => {
    seedRow('secret-pick', { picks: { [ALICE]: 'red', [BOB]: 'blue' }, revealed: false });
    const bobRes = await read(BOB);
    expect(bobRes.status).toBe(200);
    const bobBody = await bobRes.text();
    expect(JSON.parse(bobBody).activity.state).toEqual({ revealed: false, pickCount: 2, myPick: 'blue' });
    expect(bobBody).not.toContain('red');
    expect(callsOf('projectState')[0]).toMatchObject({
      viewerId: BOB,
      ctx: { sessionId: 'sess-1', serverId: 'srv-1', hostId: HOST },
    });

    const hostBody = (await (await read(HOST)).json()) as { activity: { state: Record<string, unknown> } };
    expect(hostBody.activity.state).toEqual({ revealed: false, pickCount: 2, myPick: null });
  });

  it('the actions response is projected for the caller', async () => {
    seedRow('secret-pick', { picks: { [BOB]: 'blue' }, revealed: false });
    const res = await act(ALICE, { type: 'pick', choice: 'red' });
    const text = await res.text();
    expect(JSON.parse(text).activity.state).toEqual({ revealed: false, pickCount: 2, myPick: 'red' });
    expect(text).not.toContain('blue');
  });

  it('GET fails closed when the projection fails: a 500, never the raw state', async () => {
    seedRow('secret-pick', { picks: { [ALICE]: 'red' }, revealed: false });
    worker.failProjection = true;
    const res = await read(BOB);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('red');
  });

  it('the actions route reports an applied action whose view could not be projected (502), without the state', async () => {
    seedRow('secret-pick', { picks: { [BOB]: 'blue' }, revealed: false });
    worker.failProjection = true;
    const res = await act(ALICE, { type: 'pick', choice: 'red' });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ applied: true });
    expect(text).not.toContain('blue');
    expect(store.row.state.picks).toEqual({ [BOB]: 'blue', [ALICE]: 'red' });
  });

  it('a plugin without projectState is public: GET returns its full state', async () => {
    seedRow('open-board', { cells: ['x', 'o'] });
    const body = (await (await read(BOB)).json()) as { activity: { state: unknown } };
    expect(body.activity.state).toEqual({ cells: ['x', 'o'] });
    expect(callsOf('projectState')).toHaveLength(0);
  });

  it('a marketplace plugin that is not loaded: GET withholds the state (rules unknown)', async () => {
    seedRow('not-loaded', { secret: 'the answer' });
    const res = await read(BOB);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).activity.state).toBeNull();
    expect(text).not.toContain('the answer');
  });
});
