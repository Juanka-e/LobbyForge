/**
 * Tests for the API request guards in lib/api-auth.ts and the
 * authorizeServerPermission helper in lib/permissions.ts.
 *
 * The pure guards (getSessionSecret, requireMaterializedSession) need only
 * an env stub + a guest-session cookie. The DB-backed guards mock
 * @lobbyforge/db so getDb() is never called for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';
import { CorePermission } from '@lobbyforge/core';

const getServerById = vi.fn();
const isServerMember = vi.fn();
const getChannelById = vi.fn();
const getUserPermissions = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  isServerMember,
  getChannelById,
  getUserPermissions,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };
const UID = '00000000-0000-0000-0000-000000000099';
const SERVER_ID = '00000000-0000-0000-0000-000000000001';
const CHANNEL_ID = '00000000-0000-0000-0000-000000000002';

function makeCookie(uid: string | null = UID): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://example.test/api/x', { headers });
}

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  vi.resetModules();
  getServerById.mockReset();
  isServerMember.mockReset();
  getChannelById.mockReset();
  getUserPermissions.mockReset();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

describe('getSessionSecret', () => {
  it('returns the configured secret when it is at least 32 chars', async () => {
    const { getSessionSecret } = await import('../api-auth.js');
    expect(getSessionSecret()).toBe(SECRET);
  });

  it('throws when the secret is missing or too short', async () => {
    process.env.LOBBYFORGE_SESSION_SECRET = 'short';
    const { getSessionSecret } = await import('../api-auth.js');
    expect(() => getSessionSecret()).toThrow(/at least 32 characters/);
  });
});

describe('requireMaterializedSession', () => {
  it('returns the session when a valid cookie with a uid is present', async () => {
    const { requireMaterializedSession } = await import('../api-auth.js');
    const result = requireMaterializedSession(req({ cookie: makeCookie() }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.uid).toBe(UID);
  });

  it('returns 401 when no cookie is present', async () => {
    const { requireMaterializedSession } = await import('../api-auth.js');
    const result = requireMaterializedSession(req());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it('returns 503 when the session has no materialized uid', async () => {
    const { requireMaterializedSession } = await import('../api-auth.js');
    const result = requireMaterializedSession(req({ cookie: makeCookie(null) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });
});

describe('requireServerMember', () => {
  it('returns ok with the server when the caller is the owner', async () => {
    getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: UID });
    const { requireServerMember } = await import('../api-auth.js');
    const result = await requireServerMember(UID, SERVER_ID);
    expect(result.ok).toBe(true);
    // Owner match short-circuits — isServerMember is never queried.
    expect(isServerMember).not.toHaveBeenCalled();
  });

  it('returns ok when the caller is a member (not owner)', async () => {
    getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: 'other' });
    isServerMember.mockResolvedValue(true);
    const { requireServerMember } = await import('../api-auth.js');
    const result = await requireServerMember(UID, SERVER_ID);
    expect(result.ok).toBe(true);
    expect(isServerMember).toHaveBeenCalledWith({ __mockDb: true }, UID, SERVER_ID);
  });

  it('returns 404 when the server does not exist', async () => {
    getServerById.mockResolvedValue(null);
    const { requireServerMember } = await import('../api-auth.js');
    const result = await requireServerMember(UID, SERVER_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });

  it('returns 403 when the caller is not the owner and not a member', async () => {
    getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: 'other' });
    isServerMember.mockResolvedValue(false);
    const { requireServerMember } = await import('../api-auth.js');
    const result = await requireServerMember(UID, SERVER_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });
});

describe('requireChannelInServer', () => {
  it('returns ok when the channel belongs to the server', async () => {
    getChannelById.mockResolvedValue({ id: CHANNEL_ID, serverId: SERVER_ID });
    const { requireChannelInServer } = await import('../api-auth.js');
    const result = await requireChannelInServer(CHANNEL_ID, SERVER_ID);
    expect(result.ok).toBe(true);
  });

  it('returns 404 when the channel belongs to a different server', async () => {
    getChannelById.mockResolvedValue({ id: CHANNEL_ID, serverId: '00000000-0000-0000-0000-0000000000DD' });
    const { requireChannelInServer } = await import('../api-auth.js');
    const result = await requireChannelInServer(CHANNEL_ID, SERVER_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });

  it('returns 404 when the channel does not exist', async () => {
    getChannelById.mockResolvedValue(null);
    const { requireChannelInServer } = await import('../api-auth.js');
    const result = await requireChannelInServer(CHANNEL_ID, SERVER_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });
});

describe('requireServerPermission', () => {
  it('returns ok when the user has the required permission', async () => {
    getUserPermissions.mockResolvedValue([CorePermission.CONNECT_VOICE]);
    const { requireServerPermission } = await import('../api-auth.js');
    const result = await requireServerPermission(UID, SERVER_ID, CorePermission.CONNECT_VOICE);
    expect(result.ok).toBe(true);
  });

  it('returns ok for ADMINISTRATOR regardless of the required permission', async () => {
    getUserPermissions.mockResolvedValue([CorePermission.ADMINISTRATOR]);
    const { requireServerPermission } = await import('../api-auth.js');
    const result = await requireServerPermission(UID, SERVER_ID, CorePermission.BAN_MEMBERS);
    expect(result.ok).toBe(true);
  });

  it('returns 403 when the user lacks the required permission', async () => {
    getUserPermissions.mockResolvedValue([CorePermission.SEND_MESSAGES]);
    const { requireServerPermission } = await import('../api-auth.js');
    const result = await requireServerPermission(UID, SERVER_ID, CorePermission.BAN_MEMBERS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });
});

describe('authorizeServerPermission (lib/permissions.ts)', () => {
  it('returns 400 when userId or serverId is missing', async () => {
    const { authorizeServerPermission } = await import('../permissions.js');
    const result = await authorizeServerPermission('', SERVER_ID, CorePermission.SEND_MESSAGES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it('returns 403 when the user has no permissions (not a member)', async () => {
    getUserPermissions.mockResolvedValue([]);
    const { authorizeServerPermission } = await import('../permissions.js');
    const result = await authorizeServerPermission(UID, SERVER_ID, CorePermission.SEND_MESSAGES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it('returns 403 when the user has permissions but not the required one', async () => {
    getUserPermissions.mockResolvedValue([CorePermission.CONNECT_VOICE]);
    const { authorizeServerPermission } = await import('../permissions.js');
    const result = await authorizeServerPermission(UID, SERVER_ID, CorePermission.MANAGE_ROLES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it('returns ok with the permissions array when granted', async () => {
    getUserPermissions.mockResolvedValue([CorePermission.CREATE_INVITE, CorePermission.SEND_MESSAGES]);
    const { authorizeServerPermission } = await import('../permissions.js');
    const result = await authorizeServerPermission(UID, SERVER_ID, CorePermission.CREATE_INVITE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.permissions).toContain(CorePermission.CREATE_INVITE);
  });
});
