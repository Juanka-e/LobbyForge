import { beforeEach, describe, expect, it, vi } from 'vitest';
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
};

vi.mock('@lobbyforge/db', () => dbFns);

vi.mock('@/lib/db', () => ({
  getDb: () => ({ __mockDbClient: true }),
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
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
vi.mock('@/lib/plugin-server-registry', () => ({
  getPluginServer: (id: string) => (id === 'fake' ? fakePlugin : null),
}));

const claimActionId = vi.fn();
const releaseActionId = vi.fn();
vi.mock('@/lib/action-idempotency', () => ({
  claimActionId: (...args: unknown[]) => claimActionId(...args),
  releaseActionId: (...args: unknown[]) => releaseActionId(...args),
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
  claimActionId.mockReset().mockResolvedValue(true);
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
    claimActionId.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
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
    dbFns.setGameSessionStateCAS.mockResolvedValue({ ok: false, row: null });
    const body = { type: 'bust-forbidden', actionId: UUID, bustedBy: 'u-p3' };

    // Session vanishes during CAS → 404, and the claim must be released.
    dbFns.setGameSessionStateCAS.mockResolvedValueOnce({
      ok: false,
      row: { ...SESSION_ROW, revision: 4, state: {} },
    });
    dbFns.setGameSessionStateCAS.mockResolvedValue({ ok: false, row: null });

    const failed = await post(body);
    expect(failed.status).toBe(404);
    expect(releaseActionId).toHaveBeenCalledWith('sess-1', UUID);
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

  it('claimed=false stays the ONLY duplicate signal (409 + duplicate flag)', async () => {
    claimActionId.mockResolvedValueOnce(false);
    const res = await post({ type: 'bust-forbidden', actionId: UUID, bustedBy: 'u-p3' });
    expect(res.status).toBe(409);
    const detail = (await res.json()) as { duplicate?: boolean };
    expect(detail.duplicate).toBe(true);
    expect(dbFns.setGameSessionStateCAS).not.toHaveBeenCalled();
  });
});
