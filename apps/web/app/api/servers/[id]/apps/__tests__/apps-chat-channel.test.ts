import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "App messages go to": an app with the `chat` permission posts its lines
 * (lib/activity-app-chat.ts) to the text or announcement channel the
 * community chose — games run in voice channels, which have no chat. The
 * apps route refuses any other channel, and tells the settings page which
 * apps can post at all (`effectPermissions`).
 */

const db = vi.hoisted(() => ({
  getChannelById: vi.fn(),
  listPluginInstallsForServer: vi.fn(async () => []),
  getPluginInstall: vi.fn(),
  upsertPluginInstall: vi.fn(),
  deletePluginInstall: vi.fn(),
  logAction: vi.fn(async () => undefined),
}));
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/api-auth', () => ({
  CorePermission: { MANAGE_SERVER: 'manage_server' },
  requireMaterializedSession: () => ({ ok: true, session: { uid: 'u-admin' } }),
  requireServerMember: async () => ({ ok: true }),
  requireServerPermission: async () => ({ ok: true }),
}));
const plugins = vi.hoisted(() => ({
  chatty: {
    manifest: { id: 'chatty', name: 'Chatty', version: '1.0.0', type: 'game', minAppVersion: '0', permissions: ['chat', 'manage_timer'], locales: ['en'], entryClient: '' },
    actionPolicies: {},
  },
  quiet: {
    manifest: { id: 'quiet', name: 'Quiet', version: '1.0.0', type: 'game', minAppVersion: '0', permissions: [], locales: ['en'], entryClient: '' },
    actionPolicies: {},
  },
}));
vi.mock('@/lib/plugin-server-registry', () => ({
  getPluginServer: (id: string) => (plugins as Record<string, unknown>)[id] ?? null,
  listPluginSummariesServer: () => [
    { id: 'chatty', name: 'Chatty', version: '1.0.0', type: 'game', catalog: null },
    { id: 'quiet', name: 'Quiet', version: '1.0.0', type: 'game', catalog: null },
  ],
}));

const SERVER = '11111111-1111-4111-8111-111111111111';
const TEXT = '22222222-2222-4222-8222-222222222222';
const VOICE = '33333333-3333-4333-8333-333333333333';

async function save(settings: Record<string, unknown>): Promise<Response> {
  const route = await import('../route.js');
  return route.POST(
    new Request(`https://chat.example.test/api/servers/${SERVER}/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'chatty', settings }),
    }),
    { params: Promise.resolve({ id: SERVER }) }
  );
}

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockClear();
  db.getChannelById.mockImplementation(async (_db: unknown, id: string) =>
    id === TEXT ? { id: TEXT, serverId: SERVER, type: 'text' } : id === VOICE ? { id: VOICE, serverId: SERVER, type: 'voice' } : null
  );
  db.upsertPluginInstall.mockImplementation(async (_db: unknown, input: { settings?: Record<string, unknown> }) => ({
    pluginId: 'chatty',
    enabled: true,
    settings: input.settings ?? {},
    createdAt: new Date(),
  }));
});

describe('POST /api/servers/{id}/apps — chatChannelId', () => {
  it('saves a text channel of this community, and null for "nowhere"', async () => {
    expect((await save({ chatChannelId: TEXT })).status).toBe(200);
    expect(db.upsertPluginInstall).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ settings: { chatChannelId: TEXT } }));
    expect((await save({ chatChannelId: null })).status).toBe(200);
  });

  it('refuses a voice channel, an unknown channel and one of another community', async () => {
    for (const id of [VOICE, '44444444-4444-4444-8444-444444444444']) {
      const res = await save({ chatChannelId: id });
      expect(res.status, id).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_chat_channel' });
    }
    db.getChannelById.mockResolvedValueOnce({ id: TEXT, serverId: 'another', type: 'text' });
    expect((await save({ chatChannelId: TEXT })).status).toBe(400);
    expect(db.upsertPluginInstall).not.toHaveBeenCalled();
  });
});

describe('GET /api/servers/{id}/apps — effectPermissions', () => {
  it('lists the host effects each app may use (the descriptive old names are not effects)', async () => {
    const route = await import('../route.js');
    const res = await route.GET(new Request(`https://chat.example.test/api/servers/${SERVER}/apps`), {
      params: Promise.resolve({ id: SERVER }),
    });
    const body = (await res.json()) as { apps: Array<{ id: string; effectPermissions: string[] }> };
    expect(Object.fromEntries(body.apps.map((app) => [app.id, app.effectPermissions]))).toEqual({ chatty: ['chat'], quiet: [] });
  });
});
