import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Interaction delivery (BOT_API_V2 §3.3–3.4): `interaction_create` goes to
 * the stream and, first in line, to the endpoint; a 2xx endpoint body
 * `{ type: 'respond', … }` within the 3 s window counts as the respond call
 * — through the same checks as the Bot API route.
 */

const db = {
  getBotInteractionForBot: vi.fn(),
  claimBotInteractionAnswer: vi.fn(),
  claimBotInteractionFollowup: vi.fn(),
  releaseBotInteractionAnswer: vi.fn(),
  releaseBotInteractionFollowup: vi.fn(),
  expireBotInteractions: vi.fn(),
  pruneBotInteractions: vi.fn(),
  failBotInteractionNow: vi.fn(),
  listUserDisplayNames: vi.fn(),
  getBotReachableChannel: vi.fn(),
};
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
const authorizeChannelMessageAccess = vi.fn();
vi.mock('@/lib/message-authorization', () => ({ authorizeChannelMessageAccess }));
const publishBotEvent = vi.fn();
const publishUserEvent = vi.fn();
const deliverToEndpoint = vi.fn();
vi.mock('../events', () => ({ publishBotEvent, publishUserEvent, deliverToEndpoint }));
const postBotMessage = vi.fn();
vi.mock('../messages', () => ({ postBotMessage, toBotApiMessage: (row: { id: string }) => ({ id: row.id }) }));

const SERVER = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const BOT = { id: 'bot-1', serverId: SERVER, name: 'Dice', type: 'custom', enabled: true, permissions: ['slash_commands', 'receive_events', 'send_messages'] };
const interaction = {
  id: 'int-1', botId: 'bot-1', commandId: 'cmd-1', serverId: SERVER, channelId: CHANNEL, userId: USER, commandName: 'roll',
  options: { sides: 6 }, status: 'pending', response: null, followupCount: 0, createdAt: new Date(), answeredAt: null,
  expiresAt: new Date(Date.now() + 15 * 60_000),
};

beforeEach(() => {
  vi.resetModules();
  for (const fn of [...Object.values(db), publishBotEvent, publishUserEvent, deliverToEndpoint, postBotMessage, authorizeChannelMessageAccess]) {
    fn.mockReset();
  }
  authorizeChannelMessageAccess.mockResolvedValue({ ok: true, context: {} });
  db.failBotInteractionNow.mockResolvedValue(true);
  db.expireBotInteractions.mockResolvedValue(0);
  db.pruneBotInteractions.mockResolvedValue({ cleared: 0, deleted: 0 });
  db.getBotInteractionForBot.mockResolvedValue(interaction);
  db.claimBotInteractionAnswer.mockResolvedValue({ ...interaction, status: 'answered' });
  db.getBotReachableChannel.mockResolvedValue({ id: CHANNEL });
  db.listUserDisplayNames.mockResolvedValue(new Map([[USER, 'Ayşe']]));
  publishBotEvent.mockResolvedValue(undefined);
  publishUserEvent.mockResolvedValue(undefined);
});

describe('parseSynchronousAnswer', () => {
  it('reads only { type: "respond", content, ephemeral? }', async () => {
    const { parseSynchronousAnswer } = await import('../interactions');
    expect(parseSynchronousAnswer(Buffer.from('{"type":"respond","content":"6","ephemeral":true}'))).toEqual({ content: '6', ephemeral: true });
    expect(parseSynchronousAnswer(Buffer.from('{"type":"respond","content":"6"}'))).toEqual({ content: '6', ephemeral: false });
    for (const body of ['', 'ok', '{"type":"ack"}', '{"type":"respond","content":6}', '[1]', 'null']) {
      expect(parseSynchronousAnswer(Buffer.from(body))).toBeNull();
    }
  });
});

describe('answerInteraction — an ephemeral answer only reaches an invoker who can still see the channel', () => {
  const answer = async (ephemeral: boolean, kind: 'respond' | 'followup' = 'respond') => {
    const { answerInteraction } = await import('../interactions');
    return answerInteraction({ bot: BOT as never, interactionId: 'int-1', content: 'only you', ephemeral, kind });
  };

  it('checks the invoker’s membership + visibility of the interaction’s channel, then publishes', async () => {
    const result = await answer(true);
    expect(result.ok).toBe(true);
    expect(authorizeChannelMessageAccess).toHaveBeenCalledWith({ userId: USER, serverId: SERVER, channelId: CHANNEL, operation: 'mutate' });
    expect(publishUserEvent).toHaveBeenCalledTimes(1);
    expect(db.failBotInteractionNow).not.toHaveBeenCalled();
  });

  it.each([
    ['left, kicked or banned (no membership)', { ok: false, response: new Response(null, { status: 403 }) }],
    ['lost the channel (role gate)', { ok: false, response: new Response(null, { status: 403 }) }],
  ])('invoker %s: nothing is published and the interaction fails for good', async (_label, refusal) => {
    authorizeChannelMessageAccess.mockResolvedValue(refusal);
    const result = await answer(true);
    expect(result).toMatchObject({ ok: false, status: 409, code: 'interaction_failed' });
    expect(publishUserEvent).not.toHaveBeenCalled();
    expect(db.failBotInteractionNow).toHaveBeenCalledWith(expect.anything(), 'int-1', 'bot-1');
  });

  it('a follow-up is checked the same way; an error in the check fails closed', async () => {
    db.getBotInteractionForBot.mockResolvedValue({ ...interaction, status: 'answered', followupCount: 1 });
    db.claimBotInteractionFollowup.mockResolvedValue({ ...interaction, status: 'answered', followupCount: 2 });
    authorizeChannelMessageAccess.mockRejectedValue(new Error('db down'));
    const result = await answer(true, 'followup');
    expect(result).toMatchObject({ ok: false, code: 'interaction_failed' });
    expect(publishUserEvent).not.toHaveBeenCalled();
  });

  it('a public answer is a channel message: the invoker check does not apply', async () => {
    postBotMessage.mockResolvedValue({ ok: true, value: { id: 'msg-1' } });
    const result = await answer(false);
    expect(result.ok).toBe(true);
    expect(authorizeChannelMessageAccess).not.toHaveBeenCalled();
    expect(postBotMessage).toHaveBeenCalled();
  });
});

describe('sweepExpiredInteractions — expiry and retention', () => {
  it('expires overdue rows every time; prunes (answers cleared, rows 24 h past expiry deleted) at most once a minute per bot', async () => {
    const { sweepExpiredInteractions, __resetInteractionPruning } = await import('../interactions');
    __resetInteractionPruning();
    const t0 = new Date('2026-10-03T12:00:00Z');
    db.expireBotInteractions.mockResolvedValue(2);
    expect(await sweepExpiredInteractions('bot-1', t0)).toBe(2);
    await sweepExpiredInteractions('bot-1', new Date(t0.getTime() + 30_000));
    expect(db.expireBotInteractions).toHaveBeenCalledTimes(2);
    expect(db.pruneBotInteractions).toHaveBeenCalledTimes(1);
    expect(db.pruneBotInteractions).toHaveBeenCalledWith(expect.anything(), { botId: 'bot-1' }, t0);
    await sweepExpiredInteractions('bot-2', new Date(t0.getTime() + 30_000));
    await sweepExpiredInteractions('bot-1', new Date(t0.getTime() + 61_000));
    expect(db.pruneBotInteractions).toHaveBeenCalledTimes(3);
  });

  it('a failing retention sweep never fails the caller', async () => {
    const { sweepExpiredInteractions, __resetInteractionPruning } = await import('../interactions');
    __resetInteractionPruning();
    db.pruneBotInteractions.mockRejectedValue(new Error('db down'));
    db.expireBotInteractions.mockResolvedValue(1);
    await expect(sweepExpiredInteractions('bot-1')).resolves.toBe(1);
  });
});

describe('dispatchInteractionCreate', () => {
  it('publishes to the stream and queues a high-priority endpoint delivery with the §4.2 payload', async () => {
    const { dispatchInteractionCreate } = await import('../interactions');
    await dispatchInteractionCreate({ bot: BOT as never, interaction: interaction as never, user: { id: USER, displayName: 'Ayşe' } });
    const data = {
      event: 'interaction_create',
      interaction: {
        id: 'int-1', commandId: 'cmd-1', commandName: 'roll', options: { sides: 6 }, channelId: CHANNEL,
        user: { id: USER, displayName: 'Ayşe' }, expiresAt: interaction.expiresAt.toISOString(),
      },
    };
    expect(publishBotEvent).toHaveBeenCalledWith('bot-1', data);
    expect(deliverToEndpoint).toHaveBeenCalledWith(expect.objectContaining({ botId: 'bot-1', serverId: SERVER, event: 'interaction_create', data, priority: 'high' }));
  });

  it('a synchronous ephemeral answer is applied as the respond call (once, with the current bot row)', async () => {
    const { dispatchInteractionCreate } = await import('../interactions');
    await dispatchInteractionCreate({ bot: BOT as never, interaction: interaction as never, user: { id: USER, displayName: 'Ayşe' } });
    const job = deliverToEndpoint.mock.calls[0]![0];
    expect(await job.authorize(BOT)).toBe(true);
    await job.onResponse({ status: 200, body: Buffer.from('{"type":"respond","content":"🎲 4","ephemeral":true}') });
    expect(db.claimBotInteractionAnswer).toHaveBeenCalledWith(
      expect.anything(),
      { interactionId: 'int-1', botId: 'bot-1', response: { content: '🎲 4', ephemeral: true } },
      expect.any(Date)
    );
    expect(publishUserEvent).toHaveBeenCalledWith(USER, expect.objectContaining({ type: 'interaction_response', response: { content: '🎲 4', ephemeral: true, followup: false } }));
    expect(postBotMessage).not.toHaveBeenCalled();
  });

  it('a synchronous public answer still needs send_messages on the CURRENT bot', async () => {
    const { dispatchInteractionCreate } = await import('../interactions');
    await dispatchInteractionCreate({ bot: BOT as never, interaction: interaction as never, user: { id: USER, displayName: 'Ayşe' } });
    const job = deliverToEndpoint.mock.calls[0]![0];
    await job.authorize({ ...BOT, permissions: ['slash_commands', 'receive_events'] });
    await job.onResponse({ status: 200, body: Buffer.from('{"type":"respond","content":"public"}') });
    expect(db.claimBotInteractionAnswer).not.toHaveBeenCalled();
    expect(postBotMessage).not.toHaveBeenCalled();
  });

  it('the endpoint delivery is dropped when the bot lost slash_commands or the channel', async () => {
    const { dispatchInteractionCreate } = await import('../interactions');
    await dispatchInteractionCreate({ bot: BOT as never, interaction: interaction as never, user: { id: USER, displayName: 'Ayşe' } });
    const job = deliverToEndpoint.mock.calls[0]![0];
    expect(await job.authorize({ ...BOT, permissions: ['receive_events'] })).toBe(false);
    db.getBotReachableChannel.mockResolvedValueOnce(null);
    expect(await job.authorize(BOT)).toBe(false);
  });

  it('no stream publish for a bot without receive_events', async () => {
    const { dispatchInteractionCreate } = await import('../interactions');
    await dispatchInteractionCreate({ bot: { ...BOT, permissions: ['slash_commands'] } as never, interaction: interaction as never, user: { id: USER, displayName: 'Ayşe' } });
    expect(publishBotEvent).not.toHaveBeenCalled();
    expect(deliverToEndpoint).toHaveBeenCalled();
  });
});
