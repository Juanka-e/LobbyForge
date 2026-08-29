import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

// Mock the db query layer — we test the route logic, not Drizzle.
const getServerById = vi.fn();
const isServerMember = vi.fn();
const getChannelById = vi.fn();
const createMessage = vi.fn();
const listMessagesForChannel = vi.fn();
const getMessageById = vi.fn();
const updateMessage = vi.fn();
const softDeleteMessage = vi.fn();
const getUserPermissions = vi.fn();
const getBlockedUserIds = vi.fn().mockResolvedValue(new Set<string>());
const logAction = vi.fn().mockResolvedValue(undefined);

const getActiveMemberTimeout = vi.fn().mockResolvedValue(null);

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  getActiveMemberTimeout,
  isServerMember,
  getChannelById,
  createMessage,
  listMessagesForChannel,
  getMessageById,
  updateMessage,
  softDeleteMessage,
  getUserPermissions,
  getBlockedUserIds,
  logAction,
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

const authorizeChannelVisibility = vi.fn().mockResolvedValue({ ok: true });
vi.mock('@/lib/permissions', () => ({
  // CorePermission.SEND_MESSAGES -> 'send_messages' (lower-snake ids).
  CorePermission: new Proxy({}, { get: (_t, key: string) => key.toLowerCase() }),
  authorizeServerPermission: async (_uid: string, _sid: string, required: string) => {
    // Derive from the mocked getUserPermissions — mirrors the real helper
    // closely enough for these route tests.
    const perms = await getUserPermissions();
    if (perms.includes('administrator') || perms.includes(required)) return { ok: true };
    return { ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) };
  },
  hasPermission: (perms: string[], required: string) =>
    perms.includes('administrator') || perms.includes(required),
  authorizeChannelVisibility: (...args: unknown[]) => authorizeChannelVisibility(...args),
}));

vi.mock('@/lib/db', () => ({
  getDb: () => ({ __mockDbClient: true }),
}));

const SECRET = 'x'.repeat(32);

const envSnapshot = { ...process.env };

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  getServerById.mockReset();
  isServerMember.mockReset();
  getChannelById.mockReset();
  createMessage.mockReset();
  listMessagesForChannel.mockReset();
  getMessageById.mockReset();
  updateMessage.mockReset();
  softDeleteMessage.mockReset();
  getUserPermissions.mockReset();
  getActiveMemberTimeout.mockReset().mockResolvedValue(null);
  logAction.mockReset();
  logAction.mockResolvedValue(undefined);
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
  return import('../[messageId]/route.js');
}

const SERVER_ID = 'srv-1';
const CHANNEL_ID = 'ch-1';
const MESSAGE_ID = 'msg-1';
const USER_ID = '00000000-0000-0000-0000-000000000001';

function mockServerAlive() {
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
  // The owner is the caller; the M13 permission helper returns
  // [administrator] implicitly for the server owner.
  getUserPermissions.mockResolvedValue(['administrator']);
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
}

function mockChannelAlive() {
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
}

function mockMessageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    userId: USER_ID,
    content: 'Hello',
    metadata: {},
    replyToId: null,
    createdAt: new Date('2026-06-09T00:00:00Z'),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('GET /api/servers/{id}/channels/{channelId}/messages', () => {
  it('returns 401 when there is no guest session', async () => {
    const { GET } = await loadListRoute();
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages`),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is not a member', async () => {
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
    isServerMember.mockResolvedValue(false);
    const { GET } = await loadListRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages`,
      { headers: { cookie: makeSessionCookie() } }
    );
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(403);
  });

  it('returns the messages ordered newest-first', async () => {
    mockServerAlive();
    listMessagesForChannel.mockResolvedValue([
      mockMessageRow({ id: 'msg-2', createdAt: new Date('2026-06-09T01:00:00Z') }),
      mockMessageRow({ id: 'msg-1', createdAt: new Date('2026-06-09T00:00:00Z') }),
    ]);
    const { GET } = await loadListRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages`,
      { headers: { cookie: makeSessionCookie() } }
    );
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { messages: { id: string }[] };
    expect(json.messages).toHaveLength(2);
    expect(json.messages[0]?.id).toBe('msg-2');
    expect(json.messages[1]?.id).toBe('msg-1');
  });

  it('rejects an invalid `before` cursor with 400', async () => {
    mockServerAlive();
    const { GET } = await loadListRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages?before=not-a-date`,
      { headers: { cookie: makeSessionCookie() } }
    );
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(400);
  });

  it('rejects a non-integer `limit` with 400', async () => {
    mockServerAlive();
    const { GET } = await loadListRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages?limit=abc`,
      { headers: { cookie: makeSessionCookie() } }
    );
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/servers/{id}/channels/{channelId}/messages', () => {
  it('rejects empty content with 400', async () => {
    mockServerAlive();
    const { POST } = await loadListRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages`,
      {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ content: '' }),
      }
    );
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(400);
  });

  it('rejects content over 4000 chars with 400', async () => {
    mockServerAlive();
    const { POST } = await loadListRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages`,
      {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ content: 'x'.repeat(4001) }),
      }
    );
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(400);
  });

  it('creates a message and returns 201', async () => {
    mockServerAlive();
    createMessage.mockResolvedValue(mockMessageRow({ content: 'hi there' }));
    const { POST } = await loadListRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages`,
      {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ content: 'hi there' }),
      }
    );
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { message: { id: string; content: string } };
    expect(json.message.id).toBe(MESSAGE_ID);
    expect(json.message.content).toBe('hi there');
    expect(createMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channelId: CHANNEL_ID, userId: USER_ID, content: 'hi there' })
    );
  });
});

describe('GET /api/servers/{id}/channels/{channelId}/messages/{messageId}', () => {
  it('returns 404 when the message does not exist', async () => {
    mockServerAlive();
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
    getMessageById.mockResolvedValue(null);
    const { GET } = await loadItemRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
      { headers: { cookie: makeSessionCookie() } }
    );
    const res = await GET(req, {
      params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the message belongs to a different channel', async () => {
    mockServerAlive();
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
    getMessageById.mockResolvedValue(mockMessageRow({ channelId: 'ch-OTHER' }));
    const { GET } = await loadItemRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
      { headers: { cookie: makeSessionCookie() } }
    );
    const res = await GET(req, {
      params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('returns the message to a non-owner member', async () => {
    mockServerAlive();
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
    getMessageById.mockResolvedValue(
      mockMessageRow({ userId: '00000000-0000-0000-0000-000000000099' })
    );
    const { GET } = await loadItemRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
      { headers: { cookie: makeSessionCookie() } }
    );
    const res = await GET(req, {
      params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { message: { id: string; content: string } };
    expect(json.message.id).toBe(MESSAGE_ID);
    expect(json.message.content).toBe('Hello');
  });
});

describe('PATCH /api/servers/{id}/channels/{channelId}/messages/{messageId}', () => {
  it('returns 403 when the caller is neither author nor server owner', async () => {
    // Caller is a member but not the owner; message author is someone else.
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
    getUserPermissions.mockResolvedValue(['send_messages', 'read_message_history', 'mention_everyone']);
    mockChannelAlive();
    getMessageById.mockResolvedValue(
      mockMessageRow({ userId: '00000000-0000-0000-0000-000000000088' })
    );
    const { PATCH } = await loadItemRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
      {
        method: 'PATCH',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ content: 'edited' }),
      }
    );
    const res = await PATCH(req, {
      params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }),
    });
    expect(res.status).toBe(403);
  });

  it('updates the message when the caller is the author', async () => {
    mockServerAlive();
    mockChannelAlive();
    getMessageById.mockResolvedValue(mockMessageRow());
    updateMessage.mockResolvedValue(
      mockMessageRow({ content: 'edited', editedAt: new Date('2026-06-09T01:00:00Z') })
    );
    const { PATCH } = await loadItemRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
      {
        method: 'PATCH',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ content: 'edited' }),
      }
    );
    const res = await PATCH(req, {
      params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { message: { content: string; editedAt: string | null } };
    expect(json.message.content).toBe('edited');
    expect(json.message.editedAt).not.toBeNull();
    expect(updateMessage).toHaveBeenCalledWith(
      expect.anything(),
      MESSAGE_ID,
      expect.objectContaining({ content: 'edited' })
    );
  });

  it('allows the server owner to edit a message they did not author', async () => {
    // Caller is owner; message author is someone else.
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
    mockChannelAlive();
    getMessageById.mockResolvedValue(
      mockMessageRow({ userId: '00000000-0000-0000-0000-000000000099' })
    );
    updateMessage.mockResolvedValue(mockMessageRow({ content: 'mod-edited' }));
    const { PATCH } = await loadItemRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
      {
        method: 'PATCH',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ content: 'mod-edited' }),
      }
    );
    const res = await PATCH(req, {
      params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { message: { content: string } };
    expect(json.message.content).toBe('mod-edited');
  });

  it('rejects arbitrary client metadata on message updates', async () => {
    mockServerAlive();
    getMessageById.mockResolvedValue(mockMessageRow());
    const { PATCH } = await loadItemRoute();
    const res = await PATCH(new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
      { method: 'PATCH', headers: { cookie: makeSessionCookie() }, body: JSON.stringify({ metadata: { bot: true } }) }
    ), { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }) });
    expect(res.status).toBe(400);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('does not let a regular message author pin their own message', async () => {
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
    getUserPermissions.mockResolvedValue(['send_messages', 'read_message_history', 'mention_everyone']);
    mockChannelAlive();
    getMessageById.mockResolvedValue(mockMessageRow());
    const { PATCH } = await loadItemRoute();
    const res = await PATCH(new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
      { method: 'PATCH', headers: { cookie: makeSessionCookie() }, body: JSON.stringify({ pinned: true }) }
    ), { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }) });
    expect(res.status).toBe(403);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('lets a server owner pin a message with server-controlled metadata', async () => {
    mockServerAlive();
    getMessageById.mockResolvedValue(mockMessageRow({ userId: '00000000-0000-0000-0000-000000000099' }));
    updateMessage.mockImplementation(async (_db, _id, patch) => mockMessageRow({ metadata: patch.metadata }));
    const { PATCH } = await loadItemRoute();
    const res = await PATCH(new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
      { method: 'PATCH', headers: { cookie: makeSessionCookie() }, body: JSON.stringify({ pinned: true }) }
    ), { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }) });
    expect(res.status).toBe(200);
    expect(updateMessage).toHaveBeenCalledWith(expect.anything(), MESSAGE_ID, {
      metadata: expect.objectContaining({ $pinnedBy: USER_ID, $pinnedAt: expect.any(String) }),
    });
  });
});

describe('DELETE /api/servers/{id}/channels/{channelId}/messages/{messageId}', () => {
  it('returns 403 when the caller is neither author nor server owner', async () => {
    // Caller is a member but not the owner; message author is someone else.
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
    getUserPermissions.mockResolvedValue(['send_messages', 'read_message_history', 'mention_everyone']);
    mockChannelAlive();
    getMessageById.mockResolvedValue(
      mockMessageRow({ userId: '00000000-0000-0000-0000-000000000088' })
    );
    const { DELETE } = await loadItemRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
      { method: 'DELETE', headers: { cookie: makeSessionCookie() } }
    );
    const res = await DELETE(req, {
      params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }),
    });
    expect(res.status).toBe(403);
  });

  it('soft-deletes the message when the caller is the author', async () => {
    mockServerAlive();
    mockChannelAlive();
    getMessageById.mockResolvedValue(mockMessageRow());
    const { DELETE } = await loadItemRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
      { method: 'DELETE', headers: { cookie: makeSessionCookie() } }
    );
    const res = await DELETE(req, {
      params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(softDeleteMessage).toHaveBeenCalledWith(expect.anything(), MESSAGE_ID);
  });
});

describe('POST message permission gates (role upgrade batch)', () => {
  it('403 for a timed-out member (MODERATE_MEMBERS)', async () => {
    mockServerAlive();
    mockChannelAlive();
    getUserPermissions.mockResolvedValue(['send_messages', 'mention_everyone']);
    getActiveMemberTimeout.mockResolvedValue(new Date(Date.now() + 60_000));
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: makeSessionCookie() },
        body: JSON.stringify({ content: 'hello' }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(403);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('403 when mentioning @everyone without MENTION_EVERYONE', async () => {
    mockServerAlive();
    mockChannelAlive();
    getUserPermissions.mockResolvedValue(['send_messages']);
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: makeSessionCookie() },
        body: JSON.stringify({ content: 'hi @everyone' }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(403);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('allows @everyone with the permission', async () => {
    mockServerAlive();
    mockChannelAlive();
    getUserPermissions.mockResolvedValue(['send_messages', 'mention_everyone']);
    createMessage.mockResolvedValue({
      id: 'm1', channelId: 'ch-1', userId: '00000000-0000-0000-0000-000000000001',
      content: 'hi @everyone', metadata: {}, createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    });
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request('https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: makeSessionCookie() },
        body: JSON.stringify({ content: 'hi @everyone' }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(201);
    expect(createMessage).toHaveBeenCalled();
  });
});

describe('GET message history permission gate', () => {
  it('403 when the member lacks READ_MESSAGE_HISTORY', async () => {
    mockServerAlive();
    mockChannelAlive();
    getUserPermissions.mockResolvedValue(['send_messages']);
    const { GET } = await import('../route.js');
    const res = await GET(
      new Request('https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages', {
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(403);
    expect(listMessagesForChannel).not.toHaveBeenCalled();
  });
});

describe('channel visibility gate (0028)', () => {
  it('403 when the member cannot see the channel (private room)', async () => {
    mockServerAlive();
    mockChannelAlive();
    getUserPermissions.mockResolvedValue(['send_messages']);
    authorizeChannelVisibility.mockResolvedValueOnce({
      ok: false,
      response: Response.json({ error: 'You do not have access to this channel' }, { status: 403 }),
    });
    const { GET } = await loadListRoute();
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages`, {
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(403);
    expect(listMessagesForChannel).not.toHaveBeenCalled();
  });

  it('owner/manage_channels bypass the gate (visibility ok)', async () => {
    mockServerAlive();
    mockChannelAlive();
    getUserPermissions.mockResolvedValue(['administrator']);
    authorizeChannelVisibility.mockResolvedValue({ ok: true });
    listMessagesForChannel.mockResolvedValue([]);
    const { GET } = await loadListRoute();
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages`, {
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(200);
  });
});
