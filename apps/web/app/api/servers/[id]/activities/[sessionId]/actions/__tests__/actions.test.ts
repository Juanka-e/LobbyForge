import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * LF-002 route-level contract tests: exactly-once dispatch per
 * (sessionId, actionId).
 *   - the same actionId twice → second dispatch is 409 duplicate
 *   - a FAILED dispatch releases the claim so an honest retry works
 *   - actionId is never forwarded to the plugin reducer
 */

const dbFns = {
  getServerById: vi.fn(),
  getGameSessionById: vi.fn(),
  isServerMember: vi.fn(),
  getUserPermissions: vi.fn(),
  listPlayersForSession: vi.fn(),
  logAction: vi.fn(),
  setGameSessionStateCAS: vi.fn(),
  canMemberAccessChannel: vi.fn(),
  withGameSessionWriteLock: vi.fn(),
};

class GameSessionBusyError extends Error {}

vi.mock('@lobbyforge/db', () => ({ ...dbFns, GameSessionBusyError }));

/** The transaction handle the write-lock helper passes to its callback. */
const TX = { __mockTx: true };

vi.mock('@/lib/db', () => ({
  getDb: () => ({ __mockDbClient: true }),
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
  // The actions route's per-user limit (its own tests cover it).
  distributedRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: Date.now() + 60_000 }),
  rateLimitResponse: () => null,
}));

vi.mock('@/lib/activity-bus', () => ({
  publishActivityStateChange: vi.fn(),
}));

vi.mock('@/lib/prepare-plugin-action', () => ({
  preparePluginAction: vi.fn(async (_db: unknown, input: { action: Record<string, unknown> }) => ({
    ok: true as const,
    action: input.action,
  })),
}));

vi.mock('@/lib/plugin-context', () => ({
  buildHttpPluginContext: vi.fn(async () => ({})),
  callHandleAction: vi.fn(
    async (
      _plugin: unknown,
      _ctx: unknown,
      state: Record<string, unknown>,
      action: Record<string, unknown>
    ) => ({ ...state, lastAction: action.type, sawActionId: action.actionId ?? null })
  ),
}));

// The SAME class the (mocked) module exports — the route's instanceof
// check must match the instances we reject with below.
const { DuplicateActionError } = await import('@/lib/action-idempotency');

// Fake plugin: player-policy action surface, mirrors the real registry shape.
const fakePlugin = {
  manifest: {
    id: 'fake',
    name: 'Fake',
    version: '0.1.0',
    type: 'game' as const,
    minAppVersion: '0.1.0',
    permissions: [],
    locales: ['en'],
    entryClient: './client.js',
  },
  actionPolicies: { 'bust-forbidden': { role: 'player' as const, actorFields: ['bustedBy'] } },
  createInitialState: () => ({ phase: 'playing' }),
  handleAction: (_ctx: unknown, state: unknown) => state,
  migrateState: (raw: unknown) => raw,
  renderClient: () => null,
};
// beta-review: a plugin whose validateAction REQUIRES the actor field
// the host injects (like poll's vote.playerId / quiz's answer.playerId).
const validatedPlugin = {
  ...fakePlugin,
  manifest: { ...fakePlugin.manifest, id: 'validated' },
  actionPolicies: { vote: { role: 'member' as const, actorFields: ['playerId'] } },
  validateAction: vi.fn((action: unknown) => {
    const a = action as Record<string, unknown>;
    return typeof a.playerId === 'string' && a.playerId.length > 0 ? null : 'vote requires a playerId string.';
  }),
};
// Plugins registered by a describe block (e.g. the REAL policy tables of
// Vampire Village and Poll for the PLUG-001 audit tests).
const extraPlugins = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/plugin-server-registry', () => ({
  getPluginServer: (id: string) =>
    id === 'fake' ? fakePlugin : id === 'validated' ? validatedPlugin : extraPlugins.get(id) ?? null,
}));

const claimActionId = vi.fn();
const releaseActionId = vi.fn();
vi.mock('@/lib/action-idempotency', () => ({
  claimActionId: (...args: unknown[]) => claimActionId(...args),
  releaseActionId: (...args: unknown[]) => releaseActionId(...args),
  DuplicateActionError: class DuplicateActionError extends Error {},
  isValidActionId: (v: unknown) =>
    typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
}));

vi.mock('@/lib/activity-projection', () => ({
  projectActivityState: (state: unknown) => state,
}));

const SECRET = 'x'.repeat(32);
const UUID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
const SESSION_ROW = {
  id: 'sess-1',
  serverId: 'srv-1',
  pluginId: 'fake',
  createdBy: 'u-host',
  status: 'active',
  state: { phase: 'playing', count: 0 },
  revision: 3,
};

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(dbFns)) fn.mockReset();
  claimActionId.mockReset().mockResolvedValue({ sessionId: 'sess-1', actionId: UUID, token: 'claim-token' });
  releaseActionId.mockReset().mockResolvedValue(undefined);
  dbFns.getServerById.mockResolvedValue({ ownerUserId: 'u-host' });
  dbFns.getGameSessionById.mockResolvedValue(SESSION_ROW);
  // Player-policy actions (bust-forbidden) verify session membership.
  dbFns.listPlayersForSession.mockResolvedValue([
    { userId: 'u-host' },
    { userId: 'u-p3' },
  ]);
  dbFns.setGameSessionStateCAS.mockImplementation(
    async (_db: unknown, _id: string, rev: number, state: Record<string, unknown>) =>
      ({ ok: true, row: { id: 'sess-1', state, status: 'active', revision: rev + 1 } })
  );
  // The session's write lock: the callback gets the transaction and the row
  // as it stands under the lock (here: what getGameSessionById serves).
  dbFns.withGameSessionWriteLock.mockImplementation(
    async (_db: unknown, id: string, fn: (tx: unknown, row: unknown) => Promise<unknown>) =>
      fn(TX, await dbFns.getGameSessionById(TX, id))
  );
  dbFns.logAction.mockResolvedValue(undefined);
});

async function post(body: unknown, uid = 'u-host'): Promise<Response> {
  const { POST } = await import('../route.js');
  const handler = POST as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest test' };
  const cookie = `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
  return handler(
    new Request('http://localhost/api/servers/srv-1/activities/sess-1/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'srv-1', sessionId: 'sess-1' }) }
  );
}

describe('POST activity actions — LF-002 idempotency', () => {
  it('rejects a duplicate actionId with 409 and does not re-run the reducer', async () => {
    const dupErr = new DuplicateActionError();
    claimActionId.mockResolvedValueOnce({ sessionId: 'sess-1', actionId: UUID, token: 't1' }).mockRejectedValueOnce(dupErr);
    const body = { type: 'bust-forbidden', actionId: UUID, bustedBy: 'u-p3' };

    const first = await post(body);
    expect(first.status).toBe(200);

    const second = await post(body);
    expect(second.status).toBe(409);
    const detail = (await second.json()) as { duplicate?: boolean };
    expect(detail.duplicate).toBe(true);
    expect(dbFns.setGameSessionStateCAS).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when the dispatch fails so an honest retry works', async () => {
    const body = { type: 'bust-forbidden', actionId: UUID, bustedBy: 'u-p3' };

    // Session vanishes before the write → 404, and the claim must be released.
    dbFns.withGameSessionWriteLock.mockImplementationOnce(
      async (_db: unknown, _id: string, fn: (tx: unknown, row: unknown) => Promise<unknown>) => fn(TX, null)
    );

    const failed = await post(body);
    expect(failed.status).toBe(404);
    expect(dbFns.setGameSessionStateCAS).not.toHaveBeenCalled();
    expect(releaseActionId).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      actionId: UUID,
      token: 'claim-token',
    });
  });

  it('a session lock that is not granted in time is a retryable 409; the claim is released', async () => {
    const { callHandleAction: cha } = (await import('@/lib/plugin-context')) as unknown as {
      callHandleAction: { mock: { calls: unknown[][] } };
    };
    const reducerCallsBefore = cha.mock.calls.length;
    dbFns.withGameSessionWriteLock.mockRejectedValueOnce(new GameSessionBusyError('busy'));
    const res = await post({ type: 'bust-forbidden', actionId: UUID, bustedBy: 'u-p3' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ retryable: true });
    expect(cha.mock.calls).toHaveLength(reducerCallsBefore);
    expect(releaseActionId).toHaveBeenCalled();
  });

  it('a write refused for a stale revision (a writer that skipped the lock) is a retryable 409', async () => {
    dbFns.setGameSessionStateCAS.mockResolvedValueOnce({ ok: false, row: { ...SESSION_ROW, revision: 9 } });
    const res = await post({ type: 'bust-forbidden', actionId: UUID, bustedBy: 'u-p3' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ revision: 9, retryable: true });
    expect(dbFns.setGameSessionStateCAS).toHaveBeenCalledTimes(1);
    expect(releaseActionId).toHaveBeenCalled();
  });

  it('never forwards actionId to the plugin reducer', async () => {
    const res = await post({ type: 'bust-forbidden', actionId: UUID, bustedBy: 'u-p3' });
    expect(res.status).toBe(200);
    // The route dispatches via callHandleAction(plugin, ctx, state, action);
    // the action is the 4th argument of the last call.
    const { callHandleAction } = (await import('@/lib/plugin-context')) as unknown as {
      callHandleAction: { mock: { calls: unknown[][] } };
    };
    const call = callHandleAction.mock.calls.at(-1);
    const action = call?.[3] as Record<string, unknown> | undefined;
    expect(action).toBeDefined();
    expect(action).not.toHaveProperty('actionId');
    expect(action).toMatchObject({ type: 'bust-forbidden', bustedBy: 'u-host' });
  });

  it('rejects a malformed actionId with 400 before claiming', async () => {
    const res = await post({ type: 'bust-forbidden', actionId: 'garbage' });
    expect(res.status).toBe(400);
    expect(claimActionId).not.toHaveBeenCalled();
  });

  it('proceeds without dedup when the body carries no actionId (legacy clients)', async () => {
    const res = await post({ type: 'bust-forbidden', bustedBy: 'u-p3' });
    expect(res.status).toBe(200);
    expect(claimActionId).not.toHaveBeenCalled();
  });

  it('keeps the claim when the dispatch succeeds (exactly-once holds)', async () => {
    const res = await post({ type: 'bust-forbidden', actionId: UUID, bustedBy: 'u-p3' });
    expect(res.status).toBe(200);
    expect(claimActionId).toHaveBeenCalledWith('sess-1', UUID);
    expect(releaseActionId).not.toHaveBeenCalled();
  });

  // ── V4-001: a Redis OUTAGE must not masquerade as "duplicate" ────
  it('returns a retryable 503 when the idempotency store THROWS (not 409)', async () => {
    const { callHandleAction: cha } = (await import('@/lib/plugin-context')) as unknown as {
      callHandleAction: { mock: { calls: unknown[][] } };
    };
    const reducerCallsBefore = cha.mock.calls.length;
    claimActionId.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'));
    const res = await post({ type: 'bust-forbidden', actionId: UUID, bustedBy: 'u-p3' });

    expect(res.status).toBe(503);
    const detail = (await res.json()) as { retryable?: boolean; duplicate?: boolean };
    expect(detail.retryable).toBe(true);
    expect(detail.duplicate).toBeUndefined();

    // The reducer and the CAS write must NEVER run for an unclaimable id.
    // (cha.mock accumulates across tests — assert it did not GROW.)
    expect(cha.mock.calls).toHaveLength(reducerCallsBefore);
    expect(dbFns.setGameSessionStateCAS).not.toHaveBeenCalled();
    expect(releaseActionId).not.toHaveBeenCalled();
  });

  it('DuplicateActionError stays the ONLY duplicate signal (409 + duplicate flag)', async () => {
    claimActionId.mockRejectedValueOnce(new DuplicateActionError());
    const res = await post({ type: 'bust-forbidden', actionId: UUID, bustedBy: 'u-p3' });
    expect(res.status).toBe(409);
    const detail = (await res.json()) as { duplicate?: boolean };
    expect(detail.duplicate).toBe(true);
    expect(dbFns.setGameSessionStateCAS).not.toHaveBeenCalled();
  });
});

describe('POST activity actions — beta-review ended-session guard', () => {
  it('rejects an action on a session whose ROW status is ended (409, no dispatch)', async () => {
    dbFns.getGameSessionById.mockResolvedValue({ ...SESSION_ROW, status: 'ended' });
    const res = await post({ type: 'bust-forbidden', bustedBy: 'u-p3' });
    expect(res.status).toBe(409);
    expect(dbFns.setGameSessionStateCAS).not.toHaveBeenCalled();
  });

  it('rejects a cancelled session too', async () => {
    dbFns.getGameSessionById.mockResolvedValue({ ...SESSION_ROW, status: 'cancelled' });
    const res = await post({ type: 'bust-forbidden', bustedBy: 'u-p3' });
    expect(res.status).toBe(409);
  });

  it('a concurrent END wins: CAS refused on a terminal row → 409, no broadcast, claim released', async () => {
    dbFns.setGameSessionStateCAS.mockResolvedValue({
      ok: false,
      row: { ...SESSION_ROW, status: 'ended', revision: 3 },
    });
    const { publishActivityStateChange } = (await import('@/lib/activity-bus')) as unknown as {
      publishActivityStateChange: { mock: { calls: unknown[][] }; mockClear: () => void };
    };
    publishActivityStateChange.mockClear();
    const res = await post({ type: 'bust-forbidden', actionId: UUID, bustedBy: 'u-p3' });
    expect(res.status).toBe(409);
    // No retry loop against an ended session.
    expect(dbFns.setGameSessionStateCAS).toHaveBeenCalledTimes(1);
    expect(publishActivityStateChange.mock.calls).toHaveLength(0);
    expect(releaseActionId).toHaveBeenCalled();
  });

  it('an END that landed while the action waited for the lock wins: 409, no reducer run, no write', async () => {
    const { callHandleAction: cha } = (await import('@/lib/plugin-context')) as unknown as {
      callHandleAction: { mock: { calls: unknown[][] } };
    };
    const reducerCallsBefore = cha.mock.calls.length;
    dbFns.withGameSessionWriteLock.mockImplementationOnce(
      async (_db: unknown, _id: string, fn: (tx: unknown, row: unknown) => Promise<unknown>) =>
        fn(TX, { ...SESSION_ROW, status: 'ended' })
    );
    const res = await post({ type: 'bust-forbidden', actionId: UUID, bustedBy: 'u-p3' });
    expect(res.status).toBe(409);
    expect(cha.mock.calls).toHaveLength(reducerCallsBefore);
    expect(dbFns.setGameSessionStateCAS).not.toHaveBeenCalled();
    expect(releaseActionId).toHaveBeenCalled();
  });
});

// The final test pass: 8 players rolling dice at once — 3 or 4 got through
// the old 3-attempt optimistic CAS, the rest saw "409 too many concurrent
// actions". Under the session's write lock each action runs its reducer on
// the row as it stands, so all of them apply, without a single retry.
describe('POST activity actions — concurrent actions on one session', () => {
  it('applies every one of 8 concurrent actions, each on the state the previous one wrote', async () => {
    let stored = { ...SESSION_ROW, state: { phase: 'playing', count: 0 } as Record<string, unknown>, revision: 3 };
    // A faithful lock: one callback at a time, each handed the CURRENT row.
    let queue: Promise<unknown> = Promise.resolve();
    dbFns.withGameSessionWriteLock.mockImplementation(
      (_db: unknown, _id: string, fn: (tx: unknown, row: unknown) => Promise<unknown>) => {
        const run = queue.then(() => fn(TX, structuredClone(stored)));
        queue = run.catch(() => undefined);
        return run;
      }
    );
    dbFns.setGameSessionStateCAS.mockImplementation(
      async (db: unknown, _id: string, rev: number, state: Record<string, unknown>) => {
        expect(db).toBe(TX); // the write goes through the lock's transaction
        await new Promise((resolve) => setTimeout(resolve, 1)); // let the other requests pile up
        if (rev !== stored.revision) return { ok: false, row: structuredClone(stored) };
        stored = { ...stored, state: structuredClone(state), revision: rev + 1 };
        return { ok: true, row: structuredClone(stored) };
      }
    );
    const { callHandleAction } = (await import('@/lib/plugin-context')) as unknown as {
      callHandleAction: { mockImplementationOnce: (fn: (...a: unknown[]) => unknown) => void };
    };
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      callHandleAction.mockImplementationOnce(async (_p: unknown, _c: unknown, state: unknown) => {
        const current = state as { count: number };
        seen.push(current.count);
        return { ...current, count: current.count + 1 };
      });
    }

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => post({ type: 'bust-forbidden', bustedBy: 'u-p3' }))
    );

    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(stored.state.count).toBe(8);
    expect(stored.revision).toBe(11);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(dbFns.setGameSessionStateCAS).toHaveBeenCalledTimes(8); // no retries, no conflicts
  });
});

describe('POST activity actions — beta-review validateAction sees injected actor fields', () => {
  it('validates AFTER actor injection (client omits playerId, server supplies it)', async () => {
    dbFns.getGameSessionById.mockResolvedValue({ ...SESSION_ROW, pluginId: 'validated' });
    const res = await post({ type: 'vote', optionId: 'opt-1' });
    expect(res.status).toBe(200);
    expect(validatedPlugin.validateAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'vote', playerId: 'u-host' })
    );
  });

  it('a client-supplied playerId is overwritten before validation and dispatch', async () => {
    dbFns.getGameSessionById.mockResolvedValue({ ...SESSION_ROW, pluginId: 'validated' });
    const res = await post({ type: 'vote', optionId: 'opt-1', playerId: 'someone-else' });
    expect(res.status).toBe(200);
    expect(validatedPlugin.validateAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ playerId: 'u-host' })
    );
  });
});

// security-review PLUG-001: the audit log is readable by every
// VIEW_AUDIT_LOG holder, so gameplay actions must not land there — a
// `pack-chat` row named a vampire, `night-*` rows named night roles, and
// `vote` rows lined up with the poll counts named anonymous voters.
describe('POST activity actions — security-review PLUG-001 audit rows', () => {
  const MEMBER = 'u-p3';

  beforeAll(async () => {
    const { vampireVillagePlugin } = await import('@lobbyforge/vampire-village');
    const { pollPlugin } = await import('@lobbyforge/poll');
    // The plugins' REAL action-policy tables; the reducer is the mocked
    // callHandleAction, so no game state is needed.
    for (const [id, policies] of [
      ['vampire-village', vampireVillagePlugin.actionPolicies],
      ['poll', pollPlugin.actionPolicies],
    ] as const) {
      extraPlugins.set(id, {
        ...fakePlugin,
        manifest: { ...fakePlugin.manifest, id },
        actionPolicies: policies,
      });
    }
  });

  beforeEach(() => {
    // A plain member (not the owner, not the host) on a visible channel.
    dbFns.isServerMember.mockResolvedValue(true);
    dbFns.getUserPermissions.mockResolvedValue(['view_channels']);
    dbFns.canMemberAccessChannel.mockResolvedValue(true);
  });

  function useSession(pluginId: string): void {
    dbFns.getGameSessionById.mockResolvedValue({ ...SESSION_ROW, pluginId, channelId: 'ch-1', state: { phase: 'night' } });
  }

  it.each([
    ['vampire-village', { type: 'pack-chat', text: 'bite the baker' }],
    ['vampire-village', { type: 'night-target', targetId: 'u-host' }],
    ['vampire-village', { type: 'night-shield', raise: true }],
    ['vampire-village', { type: 'vote', targetId: 'u-host' }],
    ['poll', { type: 'vote', optionId: 'opt-1' }],
  ])('%s %o changes state but writes NO audit row', async (pluginId, body) => {
    useSession(pluginId);
    const res = await post(body, MEMBER);
    expect(res.status).toBe(200);
    expect(dbFns.setGameSessionStateCAS).toHaveBeenCalledTimes(1);
    expect(dbFns.logAction).not.toHaveBeenCalled();
  });

  it.each([
    ['vampire-village', 'start'],
    ['vampire-village', 'kick'],
    ['poll', 'close-poll'],
  ])('%s host action %s that changes state is still audited', async (pluginId, type) => {
    useSession(pluginId);
    const res = await post({ type });
    expect(res.status).toBe(200);
    expect(dbFns.logAction).toHaveBeenCalledTimes(1);
    expect(dbFns.logAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: 'u-host',
        action: 'activity.action',
        targetId: 'sess-1',
        metadata: { pluginId, actionType: type },
      })
    );
  });

  it('a REFUSED host action (reducer returned the same state) writes nothing', async () => {
    useSession('vampire-village');
    const { callHandleAction } = (await import('@/lib/plugin-context')) as unknown as {
      callHandleAction: { mockImplementationOnce: (fn: (...a: unknown[]) => unknown) => void };
    };
    callHandleAction.mockImplementationOnce(async (_p: unknown, _c: unknown, state: unknown) => state);
    const res = await post({ type: 'start' });
    expect(res.status).toBe(200);
    expect(dbFns.logAction).not.toHaveBeenCalled();
  });

  it('an explicit `audit` flag overrides the role default', async () => {
    extraPlugins.set('flagged', {
      ...fakePlugin,
      manifest: { ...fakePlugin.manifest, id: 'flagged' },
      actionPolicies: {
        roll: { role: 'member', audit: true },
        reveal: { role: 'host', audit: false },
      },
    });
    useSession('flagged');
    expect((await post({ type: 'roll' }, MEMBER)).status).toBe(200);
    expect(dbFns.logAction).toHaveBeenCalledTimes(1);
    expect((await post({ type: 'reveal' })).status).toBe(200);
    expect(dbFns.logAction).toHaveBeenCalledTimes(1);
  });
});

// An action type that names an Object.prototype member must not resolve
// to an inherited "policy" (no `role` → neither the host nor the player
// check ran). It falls back to host-only like any unknown type.
describe('POST activity actions — inherited property names are not policies', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'a non-host member sending type %s is refused (host default)',
    async (type) => {
      dbFns.isServerMember.mockResolvedValue(true);
      dbFns.getUserPermissions.mockResolvedValue(['view_channels']);
      dbFns.canMemberAccessChannel.mockResolvedValue(true);
      const res = await post({ type }, 'u-p3');
      expect(res.status).toBe(403);
      expect(dbFns.setGameSessionStateCAS).not.toHaveBeenCalled();
    }
  );
});
