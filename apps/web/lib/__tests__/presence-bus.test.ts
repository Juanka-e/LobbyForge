/**
 * Tests for the presence bus Redis pub/sub publisher (lib/presence-bus.ts).
 *
 * Mirrors the chat-bus pattern: the publish path is fire-and-forget and
 * never throws. We mock @/lib/redis so no real Redis is needed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const publish = vi.fn(async (_channel: string, _raw: string) => 1);

vi.mock('../redis', () => ({
  redis: { publish },
}));

beforeEach(() => {
  publish.mockReset();
  publish.mockResolvedValue(1);
  vi.stubEnv('NODE_ENV', 'test');
});

describe('publishPresenceChange', () => {
  it('publishes the event JSON to the server-wide presence topic', async () => {
    const { publishPresenceChange } = await import('../presence-bus.js');
    const event = {
      type: 'presence-update' as const,
      userId: 'user-1',
      status: 'online',
      channelId: 'ch-1',
      lastSeen: 1234,
    };
    publishPresenceChange({ serverId: 'srv-1', event });
    // publish is fire-and-forget (microtask) — flush before asserting.
    await new Promise((r) => setImmediate(r));
    expect(publish).toHaveBeenCalledTimes(1);
    const [topic, raw] = publish.mock.calls[0] as [string, string];
    expect(topic).toBe('lf:test:presence:srv-1');
    expect(JSON.parse(raw)).toEqual(event);
  });

  it('includes the activity field when provided', async () => {
    const { publishPresenceChange } = await import('../presence-bus.js');
    publishPresenceChange({
      serverId: 'srv-1',
      event: {
        type: 'presence-update',
        userId: 'user-1',
        status: 'online',
        channelId: 'ch-1',
        lastSeen: 1,
        activity: { kind: 'game', label: 'Hushle' },
      },
    });
    await new Promise((r) => setImmediate(r));
    const raw = (publish.mock.calls[0] as [string, string])[1];
    expect(JSON.parse(raw).activity).toEqual({ kind: 'game', label: 'Hushle' });
  });

  it('never throws when the publish rejects (fire-and-forget)', async () => {
    publish.mockRejectedValue(new Error('redis down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { publishPresenceChange } = await import('../presence-bus.js');
    expect(() =>
      publishPresenceChange({
        serverId: 'srv-1',
        event: { type: 'presence-update', userId: 'u', status: 'online', channelId: 'c', lastSeen: 1 },
      })
    ).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
