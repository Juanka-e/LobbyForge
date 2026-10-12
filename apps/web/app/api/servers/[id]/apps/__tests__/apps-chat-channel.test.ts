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
  getPluginInstall: vi.fn(async (..._args: unknown[]) => null as { enabled: boolean; settings: Record<string, unknown> } | null),
  upsertPluginInstall: vi.fn(),
  deletePluginInstall: vi.fn(async () => true),
  logAction: vi.fn(async (..._args: unknown[]) => undefined),
  /** Role-gated channels have overrides: not open. */
  isChannelOpenToBots: vi.fn(async (_db: unknown, id: string) => !access.gated.has(id)),
  endOpenGameSessionsForPlugin: vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>),
}));
/** Who saves: their permissions, whether they own the community, which channels they cannot see. */
const access = vi.hoisted(() => ({
  permissions: ['manage_server'] as string[],
  owner: false,
  gated: new Set<string>(),
  hidden: new Set<string>(),
}));
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/api-auth', () => ({
  CorePermission: { MANAGE_SERVER: 'manage_server' },
  requireMaterializedSession: () => ({ ok: true, session: { uid: 'u-admin' } }),
  requireServerMember: async () => ({ ok: true, server: { ownerUserId: access.owner ? 'u-admin' : 'u-owner' } }),
  requireServerPermission: async () => ({ ok: true, permissions: access.permissions }),
}));
const authorizeChannelVisibility = vi.hoisted(() =>
  vi.fn(async (_uid: string, _server: string, channelId: string) => ({ ok: !access.hidden.has(channelId) }))
);
vi.mock('@/lib/permissions', () => ({ authorizeChannelVisibility }));
const publish = vi.hoisted(() => vi.fn());
vi.mock('@/lib/activity-bus', () => ({ publishActivityStateChange: publish }));
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

const PRIVATE = '55555555-5555-4555-8555-555555555555';

async function save(settings: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Response> {
  const route = await import('../route.js');
  return route.POST(
    new Request(`https://chat.example.test/api/servers/${SERVER}/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'chatty', settings, ...extra }),
    }),
    { params: Promise.resolve({ id: SERVER }) }
  );
}

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockClear();
  publish.mockClear();
  authorizeChannelVisibility.mockClear();
  access.permissions = ['manage_server'];
  access.owner = false;
  access.gated = new Set([PRIVATE]);
  access.hidden = new Set();
  db.getPluginInstall.mockResolvedValue(null);
  db.endOpenGameSessionsForPlugin.mockResolvedValue([]);
  db.getChannelById.mockImplementation(async (_db: unknown, id: string) =>
    id === TEXT
      ? { id: TEXT, serverId: SERVER, type: 'text' }
      : id === PRIVATE
        ? { id: PRIVATE, serverId: SERVER, type: 'text' }
        : id === VOICE
          ? { id: VOICE, serverId: SERVER, type: 'voice' }
          : null
  );
  db.upsertPluginInstall.mockImplementation(async (_db: unknown, input: { enabled?: boolean; settings?: Record<string, unknown> }) => ({
    pluginId: 'chatty',
    enabled: input.enabled ?? true,
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

  it('a role-gated channel needs Manage Channels (as a bot channel grant does): Manage Server alone is refused', async () => {
    const res = await save({ chatChannelId: PRIVATE });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'chat_channel_not_allowed' });
    expect(db.upsertPluginInstall).not.toHaveBeenCalled();
  });

  it('a role-gated channel is accepted from a member with Manage Channels, an administrator or the owner', async () => {
    for (const setup of [
      () => (access.permissions = ['manage_server', 'manage_channels']),
      () => (access.permissions = ['administrator']),
      () => {
        access.permissions = ['manage_server'];
        access.owner = true;
      },
    ]) {
      setup();
      expect((await save({ chatChannelId: PRIVATE })).status).toBe(200);
    }
    expect(db.upsertPluginInstall).toHaveBeenCalledTimes(3);
  });

  it('a channel the setter cannot see is refused', async () => {
    access.permissions = ['manage_server', 'manage_channels'];
    access.hidden = new Set([PRIVATE]);
    expect((await save({ chatChannelId: PRIVATE })).status).toBe(403);
    expect(authorizeChannelVisibility).toHaveBeenCalledWith('u-admin', SERVER, PRIVATE, 'u-owner');
    expect(db.upsertPluginInstall).not.toHaveBeenCalled();
  });

  it('saving other settings keeps a role-gated channel someone else chose (only a change is checked)', async () => {
    db.getPluginInstall.mockResolvedValue({ enabled: true, settings: { chatChannelId: PRIVATE } });
    expect((await save({ chatChannelId: PRIVATE, overflowPolicy: 'queue' })).status).toBe(200);
    expect(db.isChannelOpenToBots).not.toHaveBeenCalled();
  });
});

describe('uninstalling or disabling an app ends its open sessions', () => {
  const OPEN = [
    { id: 'sess-1', serverId: SERVER, status: 'ended', createdBy: 'u-host', publicSummary: { score: 3 } },
    { id: 'sess-2', serverId: SERVER, status: 'ended', createdBy: 'u-admin', publicSummary: {} },
  ];

  async function uninstall(): Promise<Response> {
    const route = await import('../route.js');
    return route.DELETE(
      new Request(`https://chat.example.test/api/servers/${SERVER}/apps`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pluginId: 'chatty' }),
      }),
      { params: Promise.resolve({ id: SERVER }) }
    );
  }

  it('uninstall: every open session of the app in the community ends, is published and audited like an end', async () => {
    db.endOpenGameSessionsForPlugin.mockResolvedValue(OPEN);
    expect((await uninstall()).status).toBe(200);
    expect(db.endOpenGameSessionsForPlugin).toHaveBeenCalledWith(expect.anything(), SERVER, 'chatty');
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ serverId: SERVER, sessionId: 'sess-1', status: 'ended' }));
    const ends = db.logAction.mock.calls.map((call) => call[1] as Record<string, unknown>).filter((row) => row.action === 'activity.end');
    expect(ends).toEqual([
      expect.objectContaining({ actorUserId: 'u-admin', targetType: 'session', targetId: 'sess-1', metadata: { pluginId: 'chatty', wasHost: false, reason: 'app_uninstalled' } }),
      expect.objectContaining({ targetId: 'sess-2', metadata: { pluginId: 'chatty', wasHost: true, reason: 'app_uninstalled' } }),
    ]);
  });

  it('disable: the same, with the reason; saving an enabled app ends nothing', async () => {
    db.endOpenGameSessionsForPlugin.mockResolvedValue(OPEN.slice(0, 1));
    expect((await save({}, { enabled: false })).status).toBe(200);
    expect(db.endOpenGameSessionsForPlugin).toHaveBeenCalledTimes(1);
    expect(db.logAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'activity.end', metadata: expect.objectContaining({ reason: 'app_disabled' }) })
    );
    db.endOpenGameSessionsForPlugin.mockClear();
    expect((await save({}, { enabled: true })).status).toBe(200);
    expect(db.endOpenGameSessionsForPlugin).not.toHaveBeenCalled();
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
