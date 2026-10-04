/**
 * ADR-007: POST /api/internal/activity-projection — the ws-gateway's
 * per-viewer projection for plugins core cannot project (marketplace
 * plugins project in the plugin worker, which only web reaches).
 * Signed requests only; the viewer's access is re-checked; failures never
 * return the unprojected state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_PROJECTION_PURPOSE,
  CORE_PROJECTED_PLUGIN_IDS,
  INTERNAL_SIGNATURE_HEADER,
  signInternalRequest,
} from '@lobbyforge/core';

const SECRET = 's'.repeat(40);

const store = vi.hoisted(() => ({
  row: null as null | { id: string; serverId: string; channelId: string; pluginId: string; status: string; state: unknown; createdBy: string; revision: number },
}));
vi.mock('@lobbyforge/db', () => ({ getGameSessionById: vi.fn(async () => structuredClone(store.row)) }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withMachineApiSecurity: (handler: unknown) => handler }));

const access = vi.hoisted(() => ({ deny: false }));
vi.mock('@/lib/activity-stream-authorization', () => ({
  denyActivityStreamAccess: vi.fn(async () => (access.deny ? new Response('{}', { status: 403 }) : null)),
}));

const registry = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/plugin-server-registry', () => ({ getPluginServer: (id: string) => registry.get(id) ?? null }));

const projectState = vi.fn(async (state: { picks: Record<string, string> }, viewer: string) => ({ myPick: state.picks[viewer] ?? null }));

async function post(body: unknown, signature?: string | null): Promise<Response> {
  const { POST } = await import('../route.js');
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const sig = signature === undefined ? signInternalRequest(SECRET, ACTIVITY_PROJECTION_PURPOSE, raw) : signature;
  if (sig) headers[INTERNAL_SIGNATURE_HEADER] = sig;
  const handler = POST as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  return handler(new Request('http://web:3000/api/internal/activity-projection', { method: 'POST', headers, body: raw }), {});
}

const REQ = { serverId: 'srv-1', sessionId: 'sess-1', viewerUserId: 'u-bob' };

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  access.deny = false;
  projectState.mockClear();
  registry.clear();
  registry.set('secret-pick', { __workerBacked: true, hasProjection: true, projectState, manifest: { id: 'secret-pick' } });
  store.row = {
    id: 'sess-1',
    serverId: 'srv-1',
    channelId: 'ch-1',
    pluginId: 'secret-pick',
    status: 'running',
    state: { picks: { 'u-alice': 'red', 'u-bob': 'blue' } },
    createdBy: 'u-host',
    revision: 7,
  };
});

describe('POST /api/internal/activity-projection', () => {
  it('a signed request gets the projection for exactly that viewer', async () => {
    const res = await post(REQ);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: 'running', revision: 7, state: { myPick: 'blue' } });
    expect(text).not.toContain('red');
    expect(projectState).toHaveBeenCalledWith(expect.anything(), 'u-bob', { sessionId: 'sess-1', serverId: 'srv-1', hostUserId: 'u-host' });
  });

  it('refuses an unsigned, mis-signed or replayed-with-another-body request (401)', async () => {
    expect((await post(REQ, null)).status).toBe(401);
    expect((await post(REQ, `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`)).status).toBe(401);
    const signedForAlice = signInternalRequest(SECRET, ACTIVITY_PROJECTION_PURPOSE, JSON.stringify({ ...REQ, viewerUserId: 'u-alice' }));
    expect((await post(REQ, signedForAlice)).status).toBe(401);
    const stale = signInternalRequest(SECRET, ACTIVITY_PROJECTION_PURPOSE, JSON.stringify(REQ), Date.now() - 5 * 60_000);
    expect((await post(REQ, stale)).status).toBe(401);
    expect(projectState).not.toHaveBeenCalled();
  });

  it('re-checks the viewer: no projection for someone who lost access (403)', async () => {
    access.deny = true;
    const res = await post(REQ);
    expect(res.status).toBe(403);
    expect(projectState).not.toHaveBeenCalled();
  });

  it('an activity of another server is not found', async () => {
    expect((await post({ ...REQ, serverId: 'srv-2' })).status).toBe(404);
  });

  it('a failed projection is a 502 without the state', async () => {
    projectState.mockRejectedValueOnce(new Error('worker down'));
    const res = await post(REQ);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toMatch(/red|blue/);
  });

  it('an unloaded plugin: the state is withheld', async () => {
    registry.clear();
    const res = await post(REQ);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: unknown }).state).toBeNull();
  });
});

describe('CORE_PROJECTED_PLUGIN_IDS (the gateway projects these locally)', () => {
  it('every id is a compiled-in plugin — otherwise a marketplace plugin with that id would be projected by core rules', async () => {
    const { PLUGINS } = await vi.importActual<typeof import('@/lib/plugin-registry')>('@/lib/plugin-registry');
    const compiled = new Set(PLUGINS.map((p) => p.manifest.id));
    for (const id of CORE_PROJECTED_PLUGIN_IDS) expect(compiled.has(id), id).toBe(true);
  }, 20_000);
});
