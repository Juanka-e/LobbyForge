// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  botV2Paths,
  createChannelWebhook,
  fetchChannelCommands,
  invalidateChannelCommands,
  invokeCommand,
  invokeErrorKey,
  parseUserEvent,
  putBotChannelAccess,
} from '../client-api';

const fetchMock = vi.fn();

beforeEach(() => {
  invalidateChannelCommands();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchChannelCommands', () => {
  it('asks once per channel and shares the answer', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ commands: [{ id: 'c1', name: 'roll', description: 'Roll', options: [], bot: { id: 'b1', name: 'Dice' } }] })
    );
    const [a, b] = await Promise.all([fetchChannelCommands('s1', 'ch1'), fetchChannelCommands('s1', 'ch1')]);
    expect(a).toEqual(b);
    expect(a.ok && a.data.map((c) => c.name)).toEqual(['roll']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/servers/s1/commands?channelId=ch1');

    await fetchChannelCommands('s1', 'ch2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed load', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'x' }, { status: 500 }));
    fetchMock.mockResolvedValueOnce(Response.json({ commands: [] }));
    expect((await fetchChannelCommands('s1', 'ch1')).ok).toBe(false);
    expect((await fetchChannelCommands('s1', 'ch1')).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('invokeCommand', () => {
  it('posts the options and reads the pending interaction', async () => {
    fetchMock.mockResolvedValue(Response.json({ interaction: { id: 'i1', status: 'pending' } }, { status: 202 }));
    const result = await invokeCommand('s1', 'ch1', 'c1', { sides: 6 });
    expect(result).toEqual({ ok: true, status: 202, data: { id: 'i1', status: 'pending', expiresAt: null } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(botV2Paths.invoke('s1', 'ch1', 'c1'));
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ options: { sides: 6 } }) });
  });

  it('carries the machine code of a refusal', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'No', code: 'missing_permission' }, { status: 403 }));
    const result = await invokeCommand('s1', 'ch1', 'c1', {});
    expect(result).toMatchObject({ ok: false, status: 403, code: 'missing_permission' });
  });

  it('reports a network failure as such', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    expect(await invokeCommand('s1', 'ch1', 'c1', {})).toMatchObject({ ok: false, status: 0, code: 'network' });
  });
});

describe('invokeErrorKey', () => {
  it('maps codes first, then statuses', () => {
    expect(invokeErrorKey({ status: 403, code: 'timed_out' })).toBe('interactions.error.timedOut');
    expect(invokeErrorKey({ status: 403, code: 'missing_permission' })).toBe('interactions.error.permission');
    expect(invokeErrorKey({ status: 400, code: 'invalid_options' })).toBe('interactions.error.invalidOptions');
    expect(invokeErrorKey({ status: 429, code: null })).toBe('interactions.error.rateLimited');
    expect(invokeErrorKey({ status: 404, code: null })).toBe('interactions.error.unavailable');
    expect(invokeErrorKey({ status: 500, code: null })).toBe('interactions.error.generic');
  });
});

describe('parseUserEvent', () => {
  it('reads an ephemeral answer', () => {
    const event = parseUserEvent({
      type: 'interaction_response',
      interaction: { id: 'i1', serverId: 's1', channelId: 'ch1', commandName: 'roll', bot: { id: 'b1', name: 'Dice' } },
      response: { content: 'You rolled 4', ephemeral: true },
      at: '2026-10-03T10:00:00.000Z',
    });
    expect(event).toMatchObject({
      kind: 'ephemeral',
      interactionId: 'i1',
      serverId: 's1',
      channelId: 'ch1',
      content: 'You rolled 4',
      commandName: 'roll',
      bot: { id: 'b1', name: 'Dice' },
      createdAt: '2026-10-03T10:00:00.000Z',
    });
  });

  it('accepts a flat payload', () => {
    expect(parseUserEvent({ interactionId: 'i2', channelId: 'ch1', content: 'hi', botName: 'Dice' })).toMatchObject({
      kind: 'ephemeral',
      interactionId: 'i2',
      bot: { id: null, name: 'Dice' },
    });
  });

  it('reads status changes and ignores everything else', () => {
    expect(parseUserEvent({ type: 'interaction_status', interaction: { id: 'i1', status: 'expired' } })).toEqual({
      kind: 'status',
      interactionId: 'i1',
      status: 'expired',
    });
    expect(parseUserEvent({ type: 'interaction_failed', interactionId: 'i1' })).toMatchObject({ status: 'failed' });
    expect(parseUserEvent({ type: 'hello' })).toBeNull();
    expect(parseUserEvent('nope')).toBeNull();
    // An answer without a channel cannot be placed anywhere.
    expect(parseUserEvent({ interaction: { id: 'i1' }, response: { content: 'x' } })).toBeNull();
  });
});

describe('admin helpers', () => {
  it('sends null for "all eligible channels" (no access rows)', async () => {
    fetchMock.mockResolvedValue(Response.json({ access: { mode: 'all', channels: [], hiddenGrantCount: 0 } }));
    await putBotChannelAccess('s1', 'b1', { mode: 'all', channelIds: ['ch1'] });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({ channelIds: null });
  });

  it('builds the webhook URL from the token when the route only sends the token', async () => {
    fetchMock.mockResolvedValue(Response.json({ webhook: { id: 'w1', name: 'CI', enabled: true }, token: 'tok_1' }, { status: 201 }));
    const result = await createChannelWebhook('s1', 'ch1', 'CI');
    expect(result.ok && result.data.url).toBe(`${window.location.origin}/api/webhooks/w1/tok_1`);
  });
});
