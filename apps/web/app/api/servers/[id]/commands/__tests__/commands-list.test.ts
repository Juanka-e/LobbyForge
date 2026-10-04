import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * The composer's `/` picker (BOT_API_V2 §3.3): only commands the member
 * could actually run in that channel, in a fixed number of queries.
 */

const db = {
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  getChannelById: vi.fn(),
  getUserPermissions: vi.fn(),
  canMemberAccessChannel: vi.fn(),
  listServerCommands: vi.fn(),
  listBotChannelAccessForServer: vi.fn(),
  isChannelOpenToBots: vi.fn(),
};
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const OWNER = '44444444-4444-4444-8444-444444444444';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const GENERAL = '22222222-2222-4222-8222-222222222222';
const STAFF = '88888888-8888-4888-8888-888888888888';
const VOICE = '66666666-6666-4666-8666-666666666666';

let perms: Record<string, string[]>;

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Tester' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function row(name: string, overrides: Record<string, unknown> = {}, botOverrides: Record<string, unknown> = {}) {
  const botId = (botOverrides.id as string) ?? 'bot-a';
  return {
    id: `cmd-${name}`,
    botId,
    serverId: SERVER,
    name,
    description: `Run ${name}`,
    options: [{ name: 'sides', description: '', type: 'integer', required: false }, { name: 'junk', type: 'exec' }],
    channelIds: null,
    adminChannelIds: null,
    requiredPermission: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    bot: { id: botId, name: 'Dice', type: 'custom', enabled: true, permissions: ['slash_commands'], channelAccessMode: 'all', ...botOverrides },
    ...overrides,
  };
}

async function list(uid: string | null, channelId: string | null = GENERAL) {
  const route = await import('../route.js');
  const qs = channelId === null ? '' : `?channelId=${channelId}`;
  return route.GET(
    new Request(`https://chat.example.test/api/servers/${SERVER}/commands${qs}`, { headers: uid ? { cookie: cookie(uid) } : {} }),
    { params: Promise.resolve({ id: SERVER }) }
  );
}

beforeEach(() => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(db)) fn.mockReset();
  perms = { [OWNER]: ['administrator'], [MEMBER]: ['send_messages', 'read_message_history'] };
  db.getServerById.mockResolvedValue({ id: SERVER, name: 'Lobby', ownerUserId: OWNER });
  db.isServerMember.mockImplementation(async (_db: unknown, uid: string) => uid in perms);
  db.getChannelById.mockImplementation(async (_db: unknown, id: string) =>
    ({ [GENERAL]: { id: GENERAL, serverId: SERVER, type: 'text' }, [STAFF]: { id: STAFF, serverId: SERVER, type: 'text' }, [VOICE]: { id: VOICE, serverId: SERVER, type: 'voice' } })[id] ?? null
  );
  db.getUserPermissions.mockImplementation(async (_db: unknown, uid: string) => perms[uid] ?? []);
  db.canMemberAccessChannel.mockImplementation(async (_db: unknown, _s: string, id: string) => id !== STAFF);
  db.listBotChannelAccessForServer.mockResolvedValue(new Map());
  db.isChannelOpenToBots.mockImplementation(async (_db: unknown, id: string) => id !== STAFF);
});

describe('GET /api/servers/{id}/commands?channelId=', () => {
  it('401 / 400 / 403 before anything is listed', async () => {
    expect((await list(null)).status).toBe(401);
    expect((await list(MEMBER, null)).status).toBe(400);
    expect((await list(MEMBER, STAFF)).status).toBe(403);
    expect((await list('99999999-9999-4999-8999-999999999999')).status).toBe(403);
    expect(db.listServerCommands).not.toHaveBeenCalled();
  });

  it('lists runnable commands with their bot, malformed options dropped', async () => {
    db.listServerCommands.mockResolvedValue([row('roll')]);
    const res = await list(MEMBER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      commands: [
        {
          id: 'cmd-roll',
          name: 'roll',
          description: 'Run roll',
          options: [{ name: 'sides', description: '', type: 'integer', required: false }],
          bot: { id: 'bot-a', name: 'Dice' },
        },
      ],
    });
  });

  it('hides disabled commands, disabled bots, bots without slash_commands, and channel-restricted ones', async () => {
    db.listServerCommands.mockResolvedValue([
      row('off', { enabled: false }),
      row('sleepy', {}, { id: 'bot-b', enabled: false }),
      row('noperm', {}, { id: 'bot-c', permissions: ['send_messages'] }),
      row('builtin', {}, { id: 'bot-d', type: 'moderation' }),
      row('elsewhere', { channelIds: [STAFF] }),
      row('managers', { adminChannelIds: [STAFF] }),
      row('ok'),
    ]);
    expect((await (await list(MEMBER)).json()).commands.map((c: { name: string }) => c.name)).toEqual(['ok']);
  });

  it('hides commands whose bot cannot reach the channel (explicit grants elsewhere)', async () => {
    db.listServerCommands.mockResolvedValue([row('granted-elsewhere', {}, { id: 'bot-g', channelAccessMode: 'selected' }), row('open')]);
    db.listBotChannelAccessForServer.mockResolvedValue(new Map([['bot-g', [STAFF]]]));
    expect((await (await list(MEMBER)).json()).commands.map((c: { name: string }) => c.name)).toEqual(['open']);
  });

  it('hides commands of a selected-mode bot that has no channel left (its last one was deleted)', async () => {
    db.listServerCommands.mockResolvedValue([row('orphan', {}, { id: 'bot-e', channelAccessMode: 'selected' }), row('open')]);
    db.listBotChannelAccessForServer.mockResolvedValue(new Map());
    expect((await (await list(MEMBER)).json()).commands.map((c: { name: string }) => c.name)).toEqual(['open']);
  });

  it('a selected-mode bot granted the channel lists its commands there', async () => {
    db.listServerCommands.mockResolvedValue([row('granted-here', {}, { id: 'bot-h', channelAccessMode: 'selected' })]);
    db.listBotChannelAccessForServer.mockResolvedValue(new Map([['bot-h', [GENERAL]]]));
    expect((await (await list(MEMBER)).json()).commands.map((c: { name: string }) => c.name)).toEqual(['granted-here']);
    // Only selected-mode bots listen: no role-gate lookup is needed.
    expect(db.isChannelOpenToBots).not.toHaveBeenCalled();
  });

  it('hides commands needing a permission the member lacks; the owner sees them', async () => {
    db.listServerCommands.mockResolvedValue([row('kick', { requiredPermission: 'kick_members' }), row('roll')]);
    expect((await (await list(MEMBER)).json()).commands.map((c: { name: string }) => c.name)).toEqual(['roll']);
    expect((await (await list(OWNER)).json()).commands.map((c: { name: string }) => c.name)).toEqual(['kick', 'roll']);
  });

  it('a voice channel has no commands; the work is a fixed number of queries', async () => {
    db.listServerCommands.mockResolvedValue([row('roll')]);
    perms[MEMBER] = ['send_messages'];
    expect((await (await list(MEMBER, VOICE)).json()).commands).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => row(`c${i}`, {}, { id: `bot-${i % 10}` }));
    db.listServerCommands.mockResolvedValue(many);
    await list(MEMBER);
    expect(db.listBotChannelAccessForServer).toHaveBeenCalledTimes(1);
    expect(db.isChannelOpenToBots).toHaveBeenCalledTimes(1);
  });
});
