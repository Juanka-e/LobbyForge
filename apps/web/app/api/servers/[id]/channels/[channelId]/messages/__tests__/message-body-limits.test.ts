import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * security-review AUTHZ-008: a member could attach about 1 MB of free-form
 * `metadata` to every message (30 a minute), which each lobby render, list
 * response and live subscriber then carried.
 *
 *   - client `metadata` is refused outright (400 `metadata_not_allowed`),
 *     whatever its keys — no first-party client sends it;
 *   - any other unknown field is a 400 (strict schema), never stored;
 *   - message create / edit routes, channel and DM, cap the body at 16 KiB
 *     (413 before the handler runs) — enough for 4000 characters of a
 *     3-byte script.
 *
 * `withApiSecurity` is replaced by a stand-in that applies the REAL body
 * limit (`enforceBodyLimit`) with the options each route passes.
 */

const getServerById = vi.fn();
const isServerMember = vi.fn();
const getChannelById = vi.fn();
const createMessage = vi.fn();
const getMessageById = vi.fn();
const updateMessage = vi.fn();
const getUserPermissions = vi.fn();
const getActiveMemberTimeout = vi.fn();
const logAction = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  isServerMember,
  getChannelById,
  createMessage,
  getMessageById,
  updateMessage,
  getUserPermissions,
  getActiveMemberTimeout,
  getBlockedUserIds: vi.fn().mockResolvedValue(new Set<string>()),
  listMessagesForChannel: vi.fn().mockResolvedValue([]),
  softDeleteMessage: vi.fn(),
  logAction,
}));

vi.mock('@/lib/security-headers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security-headers')>('@/lib/security-headers');
  return {
    applySecurityHeaders: (r: unknown) => r,
    withApiSecurity:
      (handler: (req: Request, ctx: unknown) => Promise<Response>, options: { maxBodyBytes?: number }) =>
      async (req: Request, ctx: unknown) => {
        const guarded = await actual.enforceBodyLimit(req, options.maxBodyBytes);
        if (guarded instanceof Response) return guarded;
        return handler(guarded, ctx);
      },
  };
});

vi.mock('@/lib/permissions', () => ({
  CorePermission: new Proxy({}, { get: (_t, key: string) => key.toLowerCase() }),
  authorizeServerPermission: async () => ({ ok: true, permissions: ['administrator'] }),
  hasPermission: () => true,
  authorizeChannelVisibility: async () => ({ ok: true }),
}));

vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDbClient: true }) }));
vi.mock('@/lib/mail/verification', () => ({ requireVerifiedEmail: async () => null }));
vi.mock('@/lib/bots/moderation', () => ({
  moderateMessage: async () => ({ action: 'allow' }),
  moderationBlockedBody: () => ({}),
}));
vi.mock('@/lib/bots/events', () => ({ emitMessageEvent: () => undefined }));
vi.mock('@/lib/chat-bus', () => ({
  publishChatMessage: () => undefined,
  publishChatMessageUpdate: () => undefined,
  publishChatMessageDelete: () => undefined,
}));

const SECRET = 'x'.repeat(32);
const SERVER_ID = '10000000-0000-4000-8000-000000000001';
const CHANNEL_ID = '20000000-0000-4000-8000-000000000001';
const MESSAGE_ID = '30000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000001';

function cookie(): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid: USER_ID, name: 'Guest test' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    userId: USER_ID,
    botId: null,
    content: 'hello',
    metadata: {},
    replyToId: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

const listCtx = { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) };
const itemCtx = { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }) };

function post(body: string): Request {
  return new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: { cookie: cookie(), 'content-type': 'application/json' },
    body,
  });
}

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  getServerById.mockReset().mockResolvedValue({ id: SERVER_ID, ownerUserId: USER_ID, deletedAt: null });
  isServerMember.mockReset().mockResolvedValue(true);
  getChannelById.mockReset().mockResolvedValue({ id: CHANNEL_ID, serverId: SERVER_ID, name: 'general', type: 'text' });
  getUserPermissions.mockReset().mockResolvedValue(['administrator']);
  getActiveMemberTimeout.mockReset().mockResolvedValue(null);
  createMessage.mockReset().mockImplementation(async (_db, input: { content: string }) => messageRow({ content: input.content }));
  getMessageById.mockReset().mockResolvedValue(messageRow());
  updateMessage.mockReset().mockImplementation(async (_db, _id, patch: { content?: string }) => messageRow({ content: patch.content ?? 'hello' }));
  logAction.mockReset().mockResolvedValue(undefined);
});

describe('POST …/messages — client metadata (AUTHZ-008)', () => {
  it('refuses metadata with an unreserved key', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(post(JSON.stringify({ content: 'hi', metadata: { note: 'x' } })), listCtx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'metadata_not_allowed' });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('refuses even an empty metadata object', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(post(JSON.stringify({ content: 'hi', metadata: {} })), listCtx);
    expect(res.status).toBe(400);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('refuses an unknown field instead of dropping it', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(post(JSON.stringify({ content: 'hi', embeds: [{ url: 'https://x.test' }] })), listCtx);
    expect(res.status).toBe(400);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('stores a plain message without any metadata from the client', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(post(JSON.stringify({ content: 'hi' })), listCtx);
    expect(res.status).toBe(201);
    const input = createMessage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input).not.toHaveProperty('metadata');
  });
});

describe('message body cap — 16 KiB (AUTHZ-008)', () => {
  it('413 for a create carrying a ~1 MB metadata blob', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(post(JSON.stringify({ content: 'hi', metadata: { blob: 'x'.repeat(1_000_000) } })), listCtx);
    expect(res.status).toBe(413);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('413 for a create just over 16 KiB', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(post(JSON.stringify({ content: 'x', pad: 'y'.repeat(16 * 1024) })), listCtx);
    expect(res.status).toBe(413);
  });

  it('accepts 4000 characters of a 3-byte script (about 12 KB of UTF-8)', async () => {
    const { POST } = await import('../route.js');
    const content = '漢'.repeat(4000);
    expect(new TextEncoder().encode(JSON.stringify({ content })).byteLength).toBeGreaterThan(8192);
    const res = await POST(post(JSON.stringify({ content })), listCtx);
    expect(res.status).toBe(201);
  });

  it('413 for an edit over 16 KiB', async () => {
    const { PATCH } = await import('../[messageId]/route.js');
    const res = await PATCH(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, {
        method: 'PATCH',
        headers: { cookie: cookie(), 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'x', pad: 'y'.repeat(17 * 1024) }),
      }),
      itemCtx
    );
    expect(res.status).toBe(413);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('413 for a direct message over 16 KiB', async () => {
    const { POST } = await import('@/app/api/dm/[channelId]/messages/route');
    const res = await POST(
      new Request(`https://example.test/api/dm/${CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: { cookie: cookie(), 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'y'.repeat(17 * 1024) }),
      }),
      { params: Promise.resolve({ channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(413);
  });
});
