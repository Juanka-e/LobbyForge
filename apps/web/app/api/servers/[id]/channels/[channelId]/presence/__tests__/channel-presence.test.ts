import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

const getServerById = vi.fn();
const getChannelById = vi.fn();
const isServerMember = vi.fn();
const getUserSettings = vi.fn();
const getBlockedUserIds = vi.fn();
const getUserPresenceInChannel = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  DEFAULT_USER_PRIVACY_SETTINGS: { hidePresence: false },
  getServerById,
  getChannelById,
  isServerMember,
  getUserSettings,
  getBlockedUserIds,
}));
vi.mock('@/lib/redis', () => ({ getUserPresenceInChannel }));
vi.mock('@/lib/presence-privacy', () => ({ applyPresencePrivacy: (p: unknown) => p }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };
const SERVER_ID = '00000000-0000-0000-0000-000000000001';
const CHANNEL_ID = '00000000-0000-0000-0000-000000000002';
const UID = '00000000-0000-0000-0000-000000000099';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  vi.resetModules();
  getServerById.mockReset();
  getChannelById.mockReset();
  isServerMember.mockReset();
  getUserSettings.mockReset();
  getBlockedUserIds.mockReset();
  getUserPresenceInChannel.mockReset();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

function makeCookie(uid: string = UID): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function ctx() {
  return { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) };
}

describe('GET /api/servers/[id]/channels/[channelId]/presence', () => {
  it('returns the channel presence for a member', async () => {
    getServerById.mockResolvedValue({ ownerUserId: UID });
    getChannelById.mockResolvedValue({ serverId: SERVER_ID });
    getUserPresenceInChannel.mockResolvedValue([{ userId: UID, status: 'online', channelId: CHANNEL_ID, lastSeen: 1 }]);
    getUserSettings.mockResolvedValue(null);
    const { GET } = await import('../route.js');
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/presence`, {
        headers: { cookie: makeCookie() },
      }),
      ctx()
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { presences: unknown[] };
    expect(json.presences).toHaveLength(1);
  });

  it('returns 404 when the channel does not belong to the server', async () => {
    getServerById.mockResolvedValue({ ownerUserId: UID });
    getChannelById.mockResolvedValue({ serverId: '00000000-0000-0000-0000-0000000000DD' });
    const { GET } = await import('../route.js');
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/presence`, {
        headers: { cookie: makeCookie() },
      }),
      ctx()
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller is not a member', async () => {
    getServerById.mockResolvedValue({ ownerUserId: '00000000-0000-0000-0000-0000000000BB' });
    getChannelById.mockResolvedValue({ serverId: SERVER_ID });
    isServerMember.mockResolvedValue(false);
    const { GET } = await import('../route.js');
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/presence`, {
        headers: { cookie: makeCookie() },
      }),
      ctx()
    );
    expect(res.status).toBe(403);
  });

  it('returns 401 when no cookie is present', async () => {
    const { GET } = await import('../route.js');
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/presence`),
      ctx()
    );
    expect(res.status).toBe(401);
  });
});
