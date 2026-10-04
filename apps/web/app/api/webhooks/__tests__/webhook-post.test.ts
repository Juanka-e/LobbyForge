import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/webhooks/{id}/{token} (BOT_API_V2 §5.1): the machine route an
 * external service posts through. The real machine boundary and in-memory
 * rate limiter run; the database, chat bus and Redis are replaced.
 */

const db = {
  getActiveChannelWebhook: vi.fn(),
  getChannelById: vi.fn(),
  touchChannelWebhookLastUsed: vi.fn(),
  createWebhookMessage: vi.fn(),
  logAction: vi.fn(),
  getBuiltInBotForServer: vi.fn(),
  isChannelOpenToBots: vi.fn(),
  listBotEventTargets: vi.fn(),
  listBotChannelAccessForServer: vi.fn(),
};
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
const publishChatMessage = vi.fn();
vi.mock('@/lib/chat-bus', () => ({ publishChatMessage }));
const maintenanceResponseForRequest = vi.fn();
vi.mock('@/lib/maintenance-guard', () => ({ maintenanceResponseForRequest }));
vi.mock('@/lib/redis', () => ({ redis: { publish: vi.fn(async () => 1) } }));

const SERVER = '11111111-1111-4111-8111-111111111111';
const GENERAL = '22222222-2222-4222-8222-222222222222';
const WEBHOOK = '0e7c0e7c-0e7c-4e7c-8e7c-0e7c0e7c0e7c';
const TOKEN = `lfw_${'T'.repeat(43)}`;
const HASH = `sha256$${createHash('sha256').update('lobbyforge:webhook-token:v1\n').update(TOKEN).digest('hex')}`;

function webhookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WEBHOOK, serverId: SERVER, channelId: GENERAL, name: 'CI', tokenHash: HASH, enabled: true,
    createdBy: null, createdByName: null, createdAt: new Date(), updatedAt: new Date(), lastUsedAt: null, ...overrides,
  };
}

function post(body: unknown, opts: { id?: string; token?: string; query?: string; raw?: boolean } = {}) {
  const id = opts.id ?? WEBHOOK;
  const token = opts.token ?? TOKEN;
  return import('../[webhookId]/[token]/route.js').then((route) =>
    route.POST(
      new Request(`https://chat.example.test/api/webhooks/${id}/${token}${opts.query ?? ''}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: opts.raw ? (body as string) : JSON.stringify(body),
      }),
      { params: Promise.resolve({ webhookId: id, token }) }
    )
  );
}

beforeEach(() => {
  vi.resetModules();
  for (const fn of [...Object.values(db), publishChatMessage, maintenanceResponseForRequest]) fn.mockReset();
  db.getActiveChannelWebhook.mockImplementation(async (_db: unknown, id: string) => (id === WEBHOOK ? webhookRow() : null));
  db.getChannelById.mockResolvedValue({ id: GENERAL, serverId: SERVER, type: 'text', name: 'general' });
  db.touchChannelWebhookLastUsed.mockResolvedValue(undefined);
  db.createWebhookMessage.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
    id: 'msg-w', channelId: input.channelId, userId: null, botId: null, content: input.content, metadata: input.metadata,
    replyToId: null, createdAt: new Date('2026-10-03T12:00:00Z'), editedAt: null, deletedAt: null,
  }));
  db.logAction.mockResolvedValue(undefined);
  db.getBuiltInBotForServer.mockResolvedValue(null);
  db.isChannelOpenToBots.mockResolvedValue(true);
  db.listBotEventTargets.mockResolvedValue([]);
  db.listBotChannelAccessForServer.mockResolvedValue(new Map());
  maintenanceResponseForRequest.mockResolvedValue(null);
});

describe('posting', () => {
  it('204: stored with no user and no bot, the webhook named in metadata, fanned out and audited', async () => {
    const res = await post({ content: '  Deploy finished  ', username: 'GitHub', embeds: [{ ignored: true }] });
    expect(res.status).toBe(204);
    expect(db.createWebhookMessage).toHaveBeenCalledWith(expect.anything(), {
      channelId: GENERAL,
      content: 'Deploy finished',
      metadata: { webhook: { id: WEBHOOK, name: 'CI', username: 'GitHub' } },
    });
    expect(publishChatMessage).toHaveBeenCalledWith({
      serverId: SERVER,
      channelId: GENERAL,
      message: expect.objectContaining({ id: 'msg-w', userId: null, botId: null, metadata: { webhook: { id: WEBHOOK, name: 'CI', username: 'GitHub' } } }),
    });
    expect(db.logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'message.create', actorUserId: null, metadata: expect.objectContaining({ webhookId: WEBHOOK }) }));
    expect(JSON.stringify(db.logAction.mock.calls)).not.toContain(TOKEN);
  });

  it('?wait=true returns the message', async () => {
    const res = await post({ content: 'hi' }, { query: '?wait=true' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ message: { id: 'msg-w', content: 'hi', author: { type: 'unknown' }, webhook: { id: WEBHOOK, name: 'CI' } } });
  });

  it('validates content (1–4000) and the display name', async () => {
    for (const body of [{}, { content: '' }, { content: '   ' }, { content: 'x'.repeat(4001) }, { content: 42 }, { content: 'hi', username: 'x'.repeat(33) }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_request' });
    }
    expect((await post('not json', { raw: true })).status).toBe(400);
    expect(db.createWebhookMessage).not.toHaveBeenCalled();
  });

  // Bidi isolates (U+2066-2069), the Arabic letter mark, the Mongolian vowel
  // separator, bidi embeddings / overrides, zero-width characters, the soft
  // hyphen, controls: a display name that renders differently than it reads
  // is refused. Built from code points — no invisible character in source.
  const cp = (codePoint: number) => String.fromCodePoint(codePoint);

  it.each([
    ['U+2066 LRI', 0x2066],
    ['U+2067 RLI', 0x2067],
    ['U+2068 FSI', 0x2068],
    ['U+2069 PDI', 0x2069],
    ['U+061C ALM', 0x061c],
    ['U+180E MVS', 0x180e],
    ['U+202E RLO', 0x202e],
    ['U+200B ZWSP', 0x200b],
    ['U+200D ZWJ', 0x200d],
    ['U+00AD soft hyphen', 0x00ad],
    ['U+0000 NUL', 0x0000],
    ['U+0085 NEL', 0x0085],
  ])('refuses a display name containing %s', async (_label, codePoint) => {
    const res = await post({ content: 'hi', username: `Git${cp(codePoint)}Hub` });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_request' });
    expect(db.createWebhookMessage).not.toHaveBeenCalled();
  });

  it('the name schema itself: invisible formatting refused, ordinary names (any script, emoji) kept', async () => {
    const { WebhookNameSchema } = await import('@/lib/bots/webhooks');
    for (const codePoint of [0x2066, 0x2067, 0x2068, 0x2069, 0x061c, 0x180e, 0x2060, 0x206f, 0xfff9]) {
      expect(WebhookNameSchema.safeParse(`CI${cp(codePoint)}`).success).toBe(false);
    }
    // Whitespace (incl. U+2028 / U+2029 / U+FEFF, which \s matches) collapses to one space.
    expect(WebhookNameSchema.parse(`Deploy${cp(0x2028)}Bot`)).toBe('Deploy Bot');
    expect(WebhookNameSchema.parse('  Git   Hub  ')).toBe('Git Hub');
    for (const name of ['GitHub Actions', 'Dağıtım botu', 'Сборка', 'ビルド', `${cp(0x1f680)} Deploy`]) {
      expect(WebhookNameSchema.parse(name)).toBe(name);
    }
  });

  it('refuses @everyone / @here outright', async () => {
    for (const content of ['@everyone deploy', 'look @here', '＠everyone']) {
      const res = await post({ content });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'mass_mention_forbidden' });
    }
  });

  it('the Moderation Bot’s content rules apply (audited against the webhook)', async () => {
    db.getBuiltInBotForServer.mockResolvedValue({
      id: '55555555-5555-4555-8555-555555555555', serverId: SERVER, name: 'Mod', type: 'moderation', enabled: true,
      permissions: ['read_messages', 'moderate_messages'], settings: { blockedWords: ['salak*'], flood: null, repeat: null },
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await post({ content: 'salaklar' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'blocked_by_moderation', rule: 'blocked_word' });
    expect(db.logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'bot.moderation.block', targetType: 'webhook', targetId: WEBHOOK }));
    expect(db.createWebhookMessage).not.toHaveBeenCalled();
  });
});

describe('authentication — the secret URL', () => {
  it('a wrong token, an unknown, disabled or malformed webhook all answer the same 404', async () => {
    const bodies: unknown[] = [];
    const wrong = await post({ content: 'x' }, { token: `lfw_${'W'.repeat(43)}` });
    bodies.push(await wrong.json());
    const unknown = await post({ content: 'x' }, { id: '12345678-1234-4234-8234-123456789012' });
    bodies.push(await unknown.json());
    db.getActiveChannelWebhook.mockResolvedValueOnce(webhookRow({ enabled: false }));
    const disabled = await post({ content: 'x' });
    bodies.push(await disabled.json());
    const malformed = await post({ content: 'x' }, { token: 'short' });
    bodies.push(await malformed.json());
    for (const res of [wrong, unknown, disabled, malformed]) expect(res.status).toBe(404);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(db.createWebhookMessage).not.toHaveBeenCalled();
  });

  it('a malformed token never reaches the database', async () => {
    await post({ content: 'x' }, { token: 'not-a-token' });
    await post({ content: 'x' }, { id: 'not-a-uuid' });
    expect(db.getActiveChannelWebhook).not.toHaveBeenCalled();
  });

  it('a webhook whose channel is gone or is no longer a text channel is 404', async () => {
    db.getChannelById.mockResolvedValueOnce(null);
    expect((await post({ content: 'x' })).status).toBe(404);
    db.getChannelById.mockResolvedValueOnce({ id: GENERAL, serverId: SERVER, type: 'voice', name: 'v' });
    expect((await post({ content: 'x' })).status).toBe(404);
  });
});

describe('limits', () => {
  it('30 posts per minute per webhook', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await post({ content: `n${i}` })).status);
    expect(statuses.filter((s) => s === 204)).toHaveLength(30);
    const last = await post({ content: 'again' });
    expect(last.status).toBe(429);
    expect(await last.json()).toMatchObject({ code: 'rate_limited' });
  });

  it('failed attempts are limited per address', async () => {
    let last = 0;
    for (let i = 0; i < 32; i++) last = (await post({ content: 'x' }, { token: `lfw_${'W'.repeat(43)}` })).status;
    expect(last).toBe(429);
  });

  it('413 for a body over 16 KiB, with a code', async () => {
    const res = await post({ content: 'x'.repeat(17 * 1024) });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'payload_too_large' });
  });
});
