/**
 * App messages (lib/activity-app-chat.ts): a plugin's `chat.post` lands in
 * the text channel the community chose for the app, with no user or bot
 * author and `metadata.app` naming the plugin; mentions ping nobody; at
 * most one per 5 s and 30 per hour per session; delivered on the chat bus
 * and audited like any message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  getPluginInstall: vi.fn(),
  getChannelById: vi.fn(),
  createAppMessage: vi.fn(),
  logAction: vi.fn(async () => undefined),
}));
vi.mock('@lobbyforge/db', () => db);
const publishChatMessage = vi.hoisted(() => vi.fn());
vi.mock('../chat-bus', () => ({ publishChatMessage }));
/** A tiny in-memory limiter keyed like the real one, with a controllable clock. */
const limiter = vi.hoisted(() => ({ now: 0, hits: new Map<string, number[]>() }));
vi.mock('../security-headers', () => ({
  distributedRateLimit: vi.fn(async (key: string, config: { windowMs: number; maxRequests: number }) => {
    const recent = (limiter.hits.get(key) ?? []).filter((at) => at > limiter.now - config.windowMs);
    const allowed = recent.length < config.maxRequests;
    if (allowed) recent.push(limiter.now);
    limiter.hits.set(key, recent);
    return { allowed, remaining: Math.max(0, config.maxRequests - recent.length), resetAt: limiter.now + config.windowMs };
  }),
}));

/** The Moderation Bot's verdict on the post (lib/bots/moderation.ts has its own tests). */
const moderateAppMessage = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ action: 'allow' }) as { action: 'allow' } | { action: 'block'; rule: string; botId: string; botName: string })
);
vi.mock('../bots/moderation', () => ({ moderateAppMessage }));

const { neutralizeMentions, postAppMessage } = await import('../activity-app-chat');

const TEXT = '11111111-1111-4111-8111-111111111111';
const input = (text = 'Team A won 12–9.') => ({
  db: {} as never,
  serverId: 'srv-1',
  sessionId: 'sess-1',
  pluginId: 'sandbox-buzzer',
  pluginName: 'Sandbox Buzzer',
  text,
});

beforeEach(() => {
  limiter.now = 1_000_000;
  limiter.hits.clear();
  for (const fn of Object.values(db)) fn.mockReset();
  db.logAction.mockResolvedValue(undefined);
  publishChatMessage.mockReset();
  moderateAppMessage.mockReset().mockResolvedValue({ action: 'allow' });
  db.getPluginInstall.mockResolvedValue({ enabled: true, settings: { chatChannelId: TEXT } });
  db.getChannelById.mockResolvedValue({ id: TEXT, serverId: 'srv-1', type: 'text' });
  db.createAppMessage.mockImplementation(async (_db: unknown, row: { channelId: string; content: string; metadata: unknown }) => ({
    id: 'msg-1',
    channelId: row.channelId,
    userId: null,
    botId: null,
    content: row.content,
    metadata: row.metadata,
    replyToId: null,
    createdAt: new Date(limiter.now),
  }));
});

describe('neutralizeMentions', () => {
  it('no @everyone, @here or @name survives as a mention; the text reads the same', () => {
    const out = neutralizeMentions('@everyone @here hi @Ayşe and ＠everyone, mail a@b.c');
    expect(out).not.toMatch(/@everyone|@here|@Ayşe/);
    expect(out.replace(/​/g, '')).toBe('@everyone @here hi @Ayşe and ＠everyone, mail a@b.c');
    // A lone "@" is not a mention and stays as it is.
    expect(neutralizeMentions('5 @ 3')).toBe('5 @ 3');
  });
});

describe('postAppMessage', () => {
  it('posts as the app: no user, no bot, metadata.app names the plugin; on the bus and in the audit log', async () => {
    const out = await postAppMessage(input('@everyone Ayşe won!'));
    expect(out).toEqual({ posted: true, messageId: 'msg-1', channelId: TEXT });
    const row = db.createAppMessage.mock.calls[0]![1] as { channelId: string; content: string; metadata: Record<string, unknown> };
    expect(row.channelId).toBe(TEXT);
    expect(row.metadata).toEqual({ app: { pluginId: 'sandbox-buzzer', name: 'Sandbox Buzzer' } });
    expect(row.content).not.toContain('@everyone');
    expect(publishChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'srv-1',
        channelId: TEXT,
        message: expect.objectContaining({ id: 'msg-1', userId: null, botId: null, bot: null, metadata: row.metadata }),
      })
    );
    expect(db.logAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorUserId: null, action: 'message.create', metadata: expect.objectContaining({ pluginId: 'sandbox-buzzer', app: true }) })
    );
  });

  it('nowhere to post: no channel chosen, the app disabled, or a channel that is not a text channel of this community', async () => {
    db.getPluginInstall.mockResolvedValueOnce({ enabled: true, settings: {} });
    expect(await postAppMessage(input())).toEqual({ posted: false, reason: 'no_channel' });
    db.getPluginInstall.mockResolvedValueOnce({ enabled: false, settings: { chatChannelId: TEXT } });
    expect(await postAppMessage(input())).toEqual({ posted: false, reason: 'no_channel' });
    db.getChannelById.mockResolvedValueOnce({ id: TEXT, serverId: 'srv-1', type: 'voice' });
    expect(await postAppMessage(input())).toEqual({ posted: false, reason: 'no_channel' });
    db.getChannelById.mockResolvedValueOnce({ id: TEXT, serverId: 'srv-other', type: 'text' });
    expect(await postAppMessage(input())).toEqual({ posted: false, reason: 'no_channel' });
    expect(db.createAppMessage).not.toHaveBeenCalled();
    // An announcement channel is fine.
    db.getChannelById.mockResolvedValueOnce({ id: TEXT, serverId: 'srv-1', type: 'announcement' });
    expect((await postAppMessage(input())).posted).toBe(true);
  });

  it('at most one post per 5 s per session', async () => {
    expect((await postAppMessage(input())).posted).toBe(true);
    limiter.now += 4_000;
    expect(await postAppMessage(input())).toEqual({ posted: false, reason: 'rate_limited' });
    limiter.now += 1_500;
    expect((await postAppMessage(input())).posted).toBe(true);
    // Another session has its own budget.
    expect((await postAppMessage({ ...input(), sessionId: 'sess-2' })).posted).toBe(true);
  });

  it('at most 30 posts per hour per session', async () => {
    let posted = 0;
    for (let i = 0; i < 40; i++) {
      if ((await postAppMessage(input())).posted) posted += 1;
      limiter.now += 6_000;
    }
    expect(posted).toBe(30);
    limiter.now += 60 * 60 * 1000;
    expect((await postAppMessage(input())).posted).toBe(true);
  });

  it('at most 60 posts per hour per community and plugin, however many sessions it restarts (security review)', async () => {
    // Restarting the activity used to give the app a fresh 30-per-hour budget.
    let posted = 0;
    for (let session = 0; session < 4; session++) {
      for (let i = 0; i < 30; i++) {
        if ((await postAppMessage({ ...input(), sessionId: `sess-${session}` })).posted) posted += 1;
        limiter.now += 6_000;
      }
    }
    expect(posted).toBe(60);
    // Another plugin, or the same plugin in another community, has its own budget.
    expect((await postAppMessage({ ...input(), sessionId: 'sess-x', pluginId: 'other-app' })).posted).toBe(true);
    expect((await postAppMessage({ ...input(), sessionId: 'sess-y', serverId: 'srv-2' })).posted).toBe(false); // srv-2 has no channel
    db.getChannelById.mockResolvedValueOnce({ id: TEXT, serverId: 'srv-2', type: 'text' });
    expect((await postAppMessage({ ...input(), sessionId: 'sess-z', serverId: 'srv-2' })).posted).toBe(true);
  });

  it('goes through the Moderation Bot’s rules on the text as written: a blocked post is dropped, nothing stored or sent', async () => {
    moderateAppMessage.mockResolvedValueOnce({ action: 'block', rule: 'blocked_word', botId: 'b', botName: 'Mod' });
    expect(await postAppMessage(input('@everyone a bad word'))).toEqual({ posted: false, reason: 'blocked_by_moderation' });
    expect(moderateAppMessage).toHaveBeenCalledWith({
      serverId: 'srv-1',
      channelId: TEXT,
      pluginId: 'sandbox-buzzer',
      pluginName: 'Sandbox Buzzer',
      sessionId: 'sess-1',
      content: '@everyone a bad word',
    });
    expect(db.createAppMessage).not.toHaveBeenCalled();
    expect(publishChatMessage).not.toHaveBeenCalled();
    expect(db.logAction).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'message.create' }));
  });

  it('the limits run before moderation, so blocked posts cannot flood the audit log', async () => {
    moderateAppMessage.mockResolvedValue({ action: 'block', rule: 'link', botId: 'b', botName: 'Mod' });
    await postAppMessage(input());
    limiter.now += 1_000;
    expect(await postAppMessage(input())).toEqual({ posted: false, reason: 'rate_limited' });
    expect(moderateAppMessage).toHaveBeenCalledTimes(1);
  });
});
