import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireMaterializedSession = vi.fn();
const requireChannelInServer = vi.fn();
const setTyping = vi.fn();
const getTypingUsers = vi.fn();

vi.mock('@/lib/api-auth', () => ({
  requireMaterializedSession,
  requireChannelInServer,
}));
vi.mock('@/lib/redis', () => ({ setTyping, getTypingUsers }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };
const SERVER_ID = '00000000-0000-0000-0000-000000000001';
const CHANNEL_ID = '00000000-0000-0000-0000-000000000002';
const UID = '00000000-0000-0000-0000-000000000099';

beforeEach(() => {
  // The route reads the cookie via readGuestSession to resolve a display name.
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  vi.resetModules();
  requireMaterializedSession.mockReset();
  requireChannelInServer.mockReset();
  setTyping.mockReset();
  getTypingUsers.mockReset();
  requireMaterializedSession.mockReturnValue({
    ok: true,
    session: { uid: UID, gid: 'g_1', name: 'Owner', exp: 123 },
  });
  requireChannelInServer.mockResolvedValue({ ok: true });
  setTyping.mockResolvedValue(undefined);
  getTypingUsers.mockResolvedValue(['Alice']);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

function ctx() {
  return { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) };
}

describe('POST /api/servers/[id]/channels/[channelId]/typing', () => {
  it('records the typing indicator and returns ok', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/typing`, {
        method: 'POST',
      }),
      ctx()
    );
    expect(res.status).toBe(200);
    expect(setTyping).toHaveBeenCalledWith(SERVER_ID, CHANNEL_ID, UID, expect.any(String));
  });

  it('returns the denied response when the channel does not belong to the server', async () => {
    requireChannelInServer.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/typing`, {
        method: 'POST',
      }),
      ctx()
    );
    expect(res.status).toBe(403);
    expect(setTyping).not.toHaveBeenCalled();
  });
});

describe('GET /api/servers/[id]/channels/[channelId]/typing', () => {
  it('returns the list of currently-typing users', async () => {
    const { GET } = await import('../route.js');
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/typing`),
      ctx()
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { typers: string[] };
    expect(json.typers).toEqual(['Alice']);
  });

  it('falls back to an empty typers list when getTypingUsers throws', async () => {
    getTypingUsers.mockRejectedValue(new Error('redis down'));
    const { GET } = await import('../route.js');
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/typing`),
      ctx()
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { typers: string[] };
    expect(json.typers).toEqual([]);
  });
});
