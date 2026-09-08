import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * LF-SEC-002 regression: the single-message route must enforce the SAME
 * canonical policy as the message list — membership + role-gated channel
 * visibility + READ_MESSAGE_HISTORY. The old local check verified only
 * membership and row relationships, so a user whose private-channel role
 * or history permission was removed could still fetch any message by
 * known ID. Mutations additionally require author-or-MANAGE_MESSAGES and
 * NEVER bypass channel visibility just because the caller authored the
 * old message.
 */

const getServerById = vi.fn();
const isServerMember = vi.fn();
const getChannelById = vi.fn();
const getMessageById = vi.fn();
const updateMessage = vi.fn();
const softDeleteMessage = vi.fn();
const getUserPermissions = vi.fn();
const logAction = vi.fn().mockResolvedValue(undefined);

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  isServerMember,
  getChannelById,
  getMessageById,
  updateMessage,
  softDeleteMessage,
  getUserPermissions,
  logAction,
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

const authorizeChannelVisibility = vi.fn().mockResolvedValue({ ok: true });
vi.mock('@/lib/permissions', () => ({
  CorePermission: new Proxy({}, { get: (_t, key: string) => key.toLowerCase() }),
  authorizeServerPermission: async (_uid: string, _sid: string, required: string) => {
    const perms = await getUserPermissions();
    if (perms.includes('administrator') || perms.includes(required)) return { ok: true };
    return { ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) };
  },
  hasPermission: (perms: string[], required: string) =>
    perms.includes('administrator') || perms.includes(required),
  authorizeChannelVisibility: (...args: unknown[]) => authorizeChannelVisibility(...args),
}));

vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDbClient: true }) }));

const SECRET = 'x'.repeat(32);
const SERVER_ID = 'srv-1';
const CHANNEL_ID = 'ch-1';
const MESSAGE_ID = 'msg-1';
const USER_ID = 'user-1';
const AUTHOR_ID = 'user-2';
const OWNER_ID = 'owner-1';

function messageRow(userId: string = AUTHOR_ID) {
  return {
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    userId,
    content: 'hello world',
    metadata: {},
    replyToId: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    editedAt: null,
    deletedAt: null,
  };
}

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of [
    getServerById,
    isServerMember,
    getChannelById,
    getMessageById,
    updateMessage,
    softDeleteMessage,
    getUserPermissions,
    authorizeChannelVisibility,
  ]) {
    fn.mockReset();
  }
  logAction.mockReset().mockResolvedValue(undefined);
  getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER_ID });
  isServerMember.mockResolvedValue(true);
  getChannelById.mockResolvedValue({ id: CHANNEL_ID, serverId: SERVER_ID });
  getMessageById.mockResolvedValue(messageRow());
  getUserPermissions.mockResolvedValue(['read_message_history', 'send_messages']);
  authorizeChannelVisibility.mockResolvedValue({ ok: true });
  updateMessage.mockImplementation(async (_db: unknown, _id: string, patch: object) => ({
    ...messageRow(),
    ...patch,
  }));
  softDeleteMessage.mockResolvedValue(undefined);
});

function makeCookie(uid: string = USER_ID): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'T' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

async function call(
  method: 'GET' | 'PATCH' | 'DELETE',
  uid: string = USER_ID,
  body?: object
): Promise<Response> {
  const mod = await import('../route.js');
  const handler = mod[method] as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  return handler(
    new Request(
      `https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`,
      {
        method,
        headers: { cookie: makeCookie(uid), 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }
    ),
    { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }) }
  );
}

describe('GET single message — LF-SEC-002 canonical policy', () => {
  it('returns the message to a member with visibility + history', async () => {
    const res = await call('GET');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { message: { id: string } };
    expect(json.message.id).toBe(MESSAGE_ID);
  });

  it('403 when the channel visibility check denies (private channel, role removed)', async () => {
    authorizeChannelVisibility.mockResolvedValue({
      ok: false,
      response: Response.json({ error: 'no access' }, { status: 403 }),
    });
    const res = await call('GET');
    expect(res.status).toBe(403);
    expect(getMessageById).not.toHaveBeenCalled();
  });

  it('403 when READ_MESSAGE_HISTORY is missing (write-only channel)', async () => {
    getUserPermissions.mockResolvedValue(['send_messages']);
    const res = await call('GET');
    expect(res.status).toBe(403);
    expect(getMessageById).not.toHaveBeenCalled();
  });

  it('404 when the message belongs to a different channel', async () => {
    getMessageById.mockResolvedValue({ ...messageRow(), channelId: 'other-channel' });
    const res = await call('GET');
    expect(res.status).toBe(404);
  });

  it('404 when the channel belongs to a different server', async () => {
    getChannelById.mockResolvedValue({ id: CHANNEL_ID, serverId: 'other-server' });
    const res = await call('GET');
    expect(res.status).toBe(404);
  });

  it('403 for a non-member', async () => {
    isServerMember.mockResolvedValue(false);
    const res = await call('GET');
    expect(res.status).toBe(403);
  });
});

describe('PATCH/DELETE single message — visibility never bypassed by authorship', () => {
  it('the author with channel access can edit their own message', async () => {
    const res = await call('PATCH', AUTHOR_ID, { content: 'edited' });
    expect(res.status).toBe(200);
    expect(updateMessage).toHaveBeenCalled();
  });

  it('LF-SEC-002: the author CANNOT edit after losing channel access', async () => {
    authorizeChannelVisibility.mockResolvedValue({
      ok: false,
      response: Response.json({ error: 'no access' }, { status: 403 }),
    });
    const res = await call('PATCH', AUTHOR_ID, { content: 'edited' });
    expect(res.status).toBe(403);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('a non-author without MANAGE_MESSAGES cannot edit', async () => {
    const res = await call('PATCH', USER_ID, { content: 'nope' });
    expect(res.status).toBe(403);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('a non-author without MANAGE_MESSAGES cannot delete', async () => {
    const res = await call('DELETE', USER_ID);
    expect(res.status).toBe(403);
    expect(softDeleteMessage).not.toHaveBeenCalled();
  });

  it('MANAGE_MESSAGES holders can moderate (with channel access)', async () => {
    getUserPermissions.mockResolvedValue(['read_message_history', 'manage_messages']);
    const res = await call('DELETE', USER_ID);
    expect(res.status).toBe(200);
    expect(softDeleteMessage).toHaveBeenCalled();
  });
});
