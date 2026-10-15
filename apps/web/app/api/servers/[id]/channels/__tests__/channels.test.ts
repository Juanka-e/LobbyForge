import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

// Mock the db query layer — we test the route logic, not Drizzle.
const getServerById = vi.fn();
const isServerMember = vi.fn();
const canMemberAccessChannel = vi.fn();
const listChannelsForServer = vi.fn();
const createChannel = vi.fn();
const getChannelById = vi.fn();
const updateChannel = vi.fn();
const deleteChannel = vi.fn();
const getUserPermissions = vi.fn();
const logAction = vi.fn().mockResolvedValue(undefined);
const listBotChannelGrantsForChannel = vi.fn().mockResolvedValue([]);
const getActiveMemberTimeout = vi.fn().mockResolvedValue(null);

vi.mock('@lobbyforge/db', () => ({
  listBotChannelGrantsForChannel,
  getServerById,
  isServerMember,
  canMemberAccessChannel,
  listChannelsForServer,
  createChannel,
  getChannelById,
  updateChannel,
  deleteChannel,
  getUserPermissions,
  logAction,
  getActiveMemberTimeout,
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

vi.mock('@/lib/db', () => ({
  getDb: () => ({ __mockDbClient: true }),
}));

vi.mock('@/lib/access-invalidation', () => ({ publishAccessInvalidation: vi.fn() }));
const queueCloseVoiceRoom = vi.fn();
vi.mock('@/lib/voice-moderation', () => ({ queueCloseVoiceRoom, queueServerVoiceSync: vi.fn() }));

const SECRET = 'x'.repeat(32);

const envSnapshot = { ...process.env };

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  getServerById.mockReset();
  isServerMember.mockReset();
  // 9th-audit: channel GET visibility — plain member, public channel.
  canMemberAccessChannel.mockReset().mockResolvedValue(true);
  getUserPermissions.mockReset().mockResolvedValue([]);
  listChannelsForServer.mockReset();
  createChannel.mockReset();
  getChannelById.mockReset();
  updateChannel.mockReset();
  deleteChannel.mockReset();
  getUserPermissions.mockReset().mockResolvedValue([]);
  logAction.mockReset();
  logAction.mockResolvedValue(undefined);
  queueCloseVoiceRoom.mockReset();
  getActiveMemberTimeout.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

function makeSessionCookie(uid: string | null = '00000000-0000-0000-0000-000000000001'): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest test' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

async function loadListRoute() {
  return import('../route.js');
}

async function loadItemRoute() {
  return import('../[channelId]/route.js');
}

const SERVER_ID = 'srv-1';
const CHANNEL_ID = 'ch-1';
const USER_ID = '00000000-0000-0000-0000-000000000001';

describe('GET /api/servers/{id}/channels', () => {
  it('returns 401 when there is no guest session', async () => {
    const { GET } = await loadListRoute();
    const res = await GET(new Request(`https://example.test/api/servers/${SERVER_ID}/channels`), {
      params: Promise.resolve({ id: SERVER_ID }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the server does not exist', async () => {
    getServerById.mockResolvedValue(null);
    const { GET } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller is not a member', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: USER_ID,
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    isServerMember.mockResolvedValue(false);
    const { GET } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(403);
  });

  it('returns the channels ordered by position', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: USER_ID,
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    isServerMember.mockResolvedValue(true);
    listChannelsForServer.mockResolvedValue([
      { id: 'ch-a', serverId: SERVER_ID, name: 'general', type: 'text', position: 0, pluginId: null, topic: null, createdAt: new Date('2026-06-09T00:00:00Z') },
      { id: 'ch-b', serverId: SERVER_ID, name: 'voice', type: 'voice', position: 1, pluginId: null, topic: null, createdAt: new Date('2026-06-09T00:00:00Z') },
    ]);
    const { GET } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { channels: { id: string; name: string }[] };
    expect(json.channels).toHaveLength(2);
    expect(json.channels[0]?.id).toBe('ch-a');
    expect(json.channels[1]?.name).toBe('voice');
  });
});

describe('POST /api/servers/{id}/channels', () => {
  it('rejects an invalid name with 400', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: USER_ID,
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['administrator']);
    const { POST } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: '#bad', type: 'text' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown channel type with 400', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: USER_ID,
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['administrator']);
    const { POST } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: 'general', type: 'bogus' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(400);
  });

  it('returns 403 when the caller lacks MANAGE_CHANNELS', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: '00000000-0000-0000-0000-000000000099',
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['send_messages']);
    const { POST } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: 'general', type: 'text' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(403);
  });

  it('creates a channel and returns 201', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: USER_ID,
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['administrator']);
    createChannel.mockResolvedValue({
      id: 'ch-new',
      serverId: SERVER_ID,
      name: 'random',
      type: 'text',
      position: 0,
      pluginId: null,
      topic: null,
      createdAt: new Date('2026-06-09T00:00:00Z'),
    });
    const { POST } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: 'random', type: 'text' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { channel: { id: string; name: string; type: string } };
    expect(json.channel.id).toBe('ch-new');
    expect(json.channel.name).toBe('random');
    expect(createChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serverId: SERVER_ID, name: 'random', type: 'text' })
    );
  });
});

describe('GET /api/servers/{id}/channels/{channelId}', () => {
  it('returns 404 when the channel does not exist', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: USER_ID,
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    isServerMember.mockResolvedValue(true);
    getChannelById.mockResolvedValue(null);
    const { GET } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the channel belongs to a different server', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: USER_ID,
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    isServerMember.mockResolvedValue(true);
    getChannelById.mockResolvedValue({
      id: CHANNEL_ID,
      serverId: 'srv-OTHER',
      name: 'x',
      type: 'text',
      position: 0,
      pluginId: null,
      topic: null,
      createdAt: new Date('2026-06-09T00:00:00Z'),
    });
    const { GET } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(404);
  });

  it('returns the channel to a non-owner member', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: '00000000-0000-0000-0000-000000000099',
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    isServerMember.mockResolvedValue(true);
    getChannelById.mockResolvedValue({
      id: CHANNEL_ID,
      serverId: SERVER_ID,
      name: 'general',
      type: 'text',
      position: 0,
      pluginId: null,
      topic: 'Welcome',
      createdAt: new Date('2026-06-09T00:00:00Z'),
    });
    const { GET } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { channel: { id: string; topic: string } };
    expect(json.channel.id).toBe(CHANNEL_ID);
    expect(json.channel.topic).toBe('Welcome');
  });
});

describe('PATCH /api/servers/{id}/channels/{channelId}', () => {
  it('returns 403 when the caller is not the server owner', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: '00000000-0000-0000-0000-000000000099',
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    const { PATCH } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
      method: 'PATCH',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ topic: 'New' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(403);
  });

  it('updates the channel when the caller is the owner', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: USER_ID,
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    getChannelById.mockResolvedValue({
      id: CHANNEL_ID,
      serverId: SERVER_ID,
      name: 'general',
      type: 'text',
      position: 0,
      pluginId: null,
      topic: 'Old',
      createdAt: new Date('2026-06-09T00:00:00Z'),
    });
    getUserPermissions.mockResolvedValue(['administrator']);
    updateChannel.mockResolvedValue({
      id: CHANNEL_ID,
      serverId: SERVER_ID,
      name: 'general',
      type: 'text',
      position: 0,
      pluginId: null,
      topic: 'New',
      createdAt: new Date('2026-06-09T00:00:00Z'),
    });
    const { PATCH } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
      method: 'PATCH',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ topic: 'New' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { channel: { topic: string } };
    expect(json.channel.topic).toBe('New');
  });

  it('returns 403 when a non-owner member lacks MANAGE_CHANNELS', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: '00000000-0000-0000-0000-000000000099',
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    isServerMember.mockResolvedValue(true);
    getChannelById.mockResolvedValue({
      id: CHANNEL_ID,
      serverId: SERVER_ID,
      name: 'general',
      type: 'text',
      position: 0,
      pluginId: null,
      topic: 'Old',
      createdAt: new Date('2026-06-09T00:00:00Z'),
    });
    getUserPermissions.mockResolvedValue(['send_messages']);
    const { PATCH } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
      method: 'PATCH',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ topic: 'New' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/servers/{id}/channels/{channelId}', () => {
  it('returns 403 when the caller is not the server owner', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: '00000000-0000-0000-0000-000000000099',
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    const { DELETE } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
      method: 'DELETE',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(403);
  });

  it('deletes the channel when the caller is the owner', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: USER_ID,
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    getChannelById.mockResolvedValue({
      id: CHANNEL_ID,
      serverId: SERVER_ID,
      name: 'general',
      type: 'text',
      position: 0,
      pluginId: null,
      topic: null,
      createdAt: new Date('2026-06-09T00:00:00Z'),
    });
    getUserPermissions.mockResolvedValue(['administrator']);
    const { DELETE } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
      method: 'DELETE',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(200);
    expect(deleteChannel).toHaveBeenCalledWith(expect.anything(), CHANNEL_ID);
    // A text channel has no voice room to end.
    expect(queueCloseVoiceRoom).not.toHaveBeenCalled();
  });

  it.each(['voice', 'stage'])('deleting a %s channel ends its voice room (everyone in it is disconnected)', async (type) => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: USER_ID,
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    getChannelById.mockResolvedValue({
      id: CHANNEL_ID,
      serverId: SERVER_ID,
      name: 'Lounge',
      type,
      position: 1,
      pluginId: null,
      topic: null,
      createdAt: new Date('2026-06-09T00:00:00Z'),
    });
    getUserPermissions.mockResolvedValue(['administrator']);
    const { DELETE } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
      method: 'DELETE',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(200);
    expect(deleteChannel).toHaveBeenCalledWith(expect.anything(), CHANNEL_ID);
    expect(queueCloseVoiceRoom).toHaveBeenCalledWith(SERVER_ID, CHANNEL_ID);
  });

  it('a refused delete ends no voice room', async () => {
    getServerById.mockResolvedValue({
      id: SERVER_ID,
      name: 'A',
      slug: null,
      ownerUserId: '00000000-0000-0000-0000-000000000099',
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    isServerMember.mockResolvedValue(true);
    getChannelById.mockResolvedValue({
      id: CHANNEL_ID,
      serverId: SERVER_ID,
      name: 'Lounge',
      type: 'voice',
      position: 1,
      pluginId: null,
      topic: null,
      createdAt: new Date('2026-06-09T00:00:00Z'),
    });
    getUserPermissions.mockResolvedValue(['send_messages']);
    const { DELETE } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
      method: 'DELETE',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(403);
    expect(deleteChannel).not.toHaveBeenCalled();
    expect(queueCloseVoiceRoom).not.toHaveBeenCalled();
  });
});

// Security review 2026-10 (A1): a timed-out MANAGE_CHANNELS member kept
// creating, editing and deleting channels.
describe('a timed-out member manages no channels (actor_timed_out)', () => {
  const OWNER_ID = '00000000-0000-0000-0000-000000000099';
  const until = new Date(Date.now() + 60_000);
  const channel = {
    id: CHANNEL_ID,
    serverId: SERVER_ID,
    name: 'general',
    type: 'voice',
    position: 0,
    pluginId: null,
    topic: null,
    createdAt: new Date('2026-06-09T00:00:00Z'),
  };

  function asTimedOutChannelManager() {
    getServerById.mockResolvedValue({ id: SERVER_ID, name: 'A', ownerUserId: OWNER_ID });
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['manage_channels']);
    getChannelById.mockResolvedValue(channel);
    getActiveMemberTimeout.mockResolvedValue(until);
  }

  async function expectTimedOut(res: Response) {
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'actor_timed_out', until: until.toISOString() });
  }

  it('POST: no channel is created', async () => {
    asTimedOutChannelManager();
    const { POST } = await loadListRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ name: 'random', type: 'text' }),
      }),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    await expectTimedOut(res);
    expect(getActiveMemberTimeout).toHaveBeenCalledWith(expect.anything(), SERVER_ID, USER_ID);
    expect(createChannel).not.toHaveBeenCalled();
  });

  it('PATCH: nothing changes', async () => {
    asTimedOutChannelManager();
    const { PATCH } = await loadItemRoute();
    const res = await PATCH(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
        method: 'PATCH',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ topic: 'New' }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    await expectTimedOut(res);
    expect(updateChannel).not.toHaveBeenCalled();
  });

  it('DELETE: nothing is deleted and no voice room ends', async () => {
    asTimedOutChannelManager();
    const { DELETE } = await loadItemRoute();
    const res = await DELETE(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
        method: 'DELETE',
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    await expectTimedOut(res);
    expect(deleteChannel).not.toHaveBeenCalled();
    expect(queueCloseVoiceRoom).not.toHaveBeenCalled();
  });
});
