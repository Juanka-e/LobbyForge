import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * docs/BOT_API_V2.md §8 — the security checklist, item by item. Most items
 * also have behavioural tests next to their routes (marked "§8" there);
 * this file holds the cross-cutting guards that keep them true as the code
 * grows.
 */

const db = {
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  getChannelById: vi.fn(),
  getUserPermissions: vi.fn(),
  canMemberAccessChannel: vi.fn(),
  getActiveMemberTimeout: vi.fn(),
  createMessage: vi.fn(),
  logAction: vi.fn(),
  getBlockedUserIds: vi.fn(),
  listMessagesForChannel: vi.fn(),
  getBuiltInBotForServer: vi.fn(),
};
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  distributedRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: Date.now() + 1000 }),
}));
vi.mock('@/lib/chat-bus', () => ({ publishChatMessage: vi.fn() }));
vi.mock('@/lib/bots/events', () => ({ emitMessageEvent: vi.fn() }));

const WEB = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(WEB, path), 'utf8');

/** Every file through which a bot reads or writes a channel, or hears about one. */
const BOT_REACHABLE_FILES = [
  'lib/bots/messages.ts',
  'lib/bots/interactions.ts',
  'lib/bots/events.ts',
  'lib/bots/welcome.ts',
  'app/api/bot/v1/channels/route.ts',
  'app/api/bot/v1/channels/[channelId]/messages/route.ts',
  'app/api/bot/v2/commands/route.ts',
  'app/api/bot/v2/interactions/[id]/respond/route.ts',
  'app/api/bot/v2/interactions/[id]/followup/route.ts',
  'app/api/servers/[id]/channels/[channelId]/commands/[commandId]/invoke/route.ts',
  'app/api/servers/[id]/commands/route.ts',
];

describe('§8.1 every bot-reachable path goes through the one access helper', () => {
  it.each(BOT_REACHABLE_FILES)('%s never applies the channel rule itself', (file) => {
    const source = read(file);
    // The raw building blocks of the rule may only be combined in
    // @lobbyforge/db's botChannelAccess.ts (and read by access.ts).
    expect(source).not.toMatch(/\blistBotAccessibleChannels\b/);
    expect(source).not.toMatch(/\bgetBotReachableChannel\b|\blistBotReachableChannels\b/);
  });

  it('the paths that resolve a single channel use botCanAccessChannel / listBotChannels / botReachesChannel', () => {
    for (const file of BOT_REACHABLE_FILES) {
      expect(read(file)).toMatch(/botCanAccessChannel|listBotChannels|botReachesChannel|resolveBotChannel|readMessagesForBot|postBotMessage|listChannelsForBot|answerInteraction/);
    }
    expect(read('lib/bots/messages.ts')).toMatch(/botCanAccessChannel\(bot, channelId\)/);
    expect(read('lib/bots/access.ts')).toMatch(/getBotReachableChannel\(getDb\(\)/);
  });
});

describe('§8.4 secrets are hashed or shown once', () => {
  it('webhook tokens are stored as a domain-separated sha256 and verified in constant time', async () => {
    const { generateWebhookToken, hashWebhookToken, verifyWebhookToken, toWebhookJson } = await import('../webhooks');
    const { token, hash } = generateWebhookToken();
    expect(hash).toBe(hashWebhookToken(token));
    expect(hash).toMatch(/^sha256\$[0-9a-f]{64}$/);
    expect(hash).not.toContain(token.slice(4));
    expect(verifyWebhookToken(token, hash)).toBe(true);
    expect(verifyWebhookToken(`${token.slice(0, -1)}x`, hash)).toBe(false);
    expect(verifyWebhookToken(token, null)).toBe(false);
    expect(read('lib/bots/webhooks.ts')).toContain('timingSafeEqual');
    const json = toWebhookJson({
      id: 'w', serverId: 's', channelId: 'c', name: 'CI', tokenHash: hash, enabled: true, createdBy: null,
      createdByName: null, createdAt: new Date(), updatedAt: new Date(), lastUsedAt: null,
    });
    expect(JSON.stringify(json)).not.toContain('sha256$');
  });

  it('an event endpoint as shown to anyone never carries its secret', async () => {
    const { toEventEndpointJson } = await import('../event-delivery');
    const json = toEventEndpointJson({
      botId: 'b', url: 'https://x.test', secret: `whsec_${'s'.repeat(43)}`, events: [], enabled: true, failureCount: 0,
      disabledReason: null, lastDeliveryAt: null, lastStatus: null, createdAt: new Date(), updatedAt: new Date(),
    });
    expect(JSON.stringify(json)).not.toContain('whsec_');
    // The only response that includes `secret` is the bot's own PUT; the
    // managers' route never touches it (comments aside).
    const botRoute = read('app/api/bot/v2/event-endpoint/route.ts');
    expect(botRoute.match(/NextResponse\.json\(\{[^}]*\bsecret\b/g)).toHaveLength(1);
    const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(withoutComments(read('app/api/servers/[id]/bots/[botId]/event-endpoint/route.ts'))).not.toMatch(/\bsecret\b/);
  });
});

describe('§8.5 outgoing deliveries never reach private networks', () => {
  it('the address is re-checked and pinned on every attempt (not only at save time)', () => {
    const source = read('lib/bots/event-delivery.ts');
    const attempt = source.slice(source.indexOf('async function runAttempt'));
    expect(attempt).toMatch(/resolveEndpointAddresses\(shape\.hostname\)/);
    expect(attempt).toMatch(/fetchIpPinned\(shape\.url, shape\.hostname, addresses/);
    // No generic fetch (which follows redirects) anywhere in the delivery path.
    expect(source).not.toMatch(/\bfetch\(/);
  });
});

describe('§8 members cannot forge bot-written metadata', () => {
  const SECRET = 'x'.repeat(32);
  const SERVER = '11111111-1111-4111-8111-111111111111';
  const CHANNEL = '22222222-2222-4222-8222-222222222222';
  const MEMBER = '33333333-3333-4333-8333-333333333333';

  beforeEach(() => {
    vi.resetModules();
    process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
    for (const fn of Object.values(db)) fn.mockReset();
    db.getServerById.mockResolvedValue({ id: SERVER, ownerUserId: '44444444-4444-4444-8444-444444444444' });
    db.isServerMember.mockResolvedValue(true);
    db.getChannelById.mockResolvedValue({ id: CHANNEL, serverId: SERVER, type: 'text' });
    db.getUserPermissions.mockResolvedValue(['send_messages', 'read_message_history']);
    db.canMemberAccessChannel.mockResolvedValue(true);
    db.getActiveMemberTimeout.mockResolvedValue(null);
    db.getBuiltInBotForServer.mockResolvedValue(null);
    db.logAction.mockResolvedValue(undefined);
  });

  it.each(['interaction', 'webhook', 'bot'])('a member message with metadata.%s is refused', async (key) => {
    const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid: MEMBER, name: 'T' };
    const route = await import('@/app/api/servers/[id]/channels/[channelId]/messages/route');
    const res = await route.POST(
      new Request(`https://chat.example.test/api/servers/${SERVER}/channels/${CHANNEL}/messages`, {
        method: 'POST',
        headers: { cookie: `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hi', metadata: { [key]: { id: 'forged', name: 'Official' } } }),
      }),
      { params: Promise.resolve({ id: SERVER, channelId: CHANNEL }) }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ key });
    expect(db.createMessage).not.toHaveBeenCalled();
  });
});
