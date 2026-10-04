import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * docs/BOT_API_V2.md §1.1 — the ONE access helper, with the REAL rule from
 * `@lobbyforge/db` (not mocked) running against a scripted fake client:
 * the stored mode decides, and a bot in `selected` mode whose last granted
 * channel was deleted reaches NOTHING — not every open channel.
 */

/** A chainable stand-in for the Drizzle client; awaiting a chain yields the next scripted result. */
const fake = vi.hoisted(() => {
  const state = { results: [] as unknown[][], calls: 0 };
  function chain(): unknown {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            const value = state.results[state.calls++] ?? [];
            return (resolve: (v: unknown) => void) => resolve(value);
          }
          return () => proxy;
        },
      }
    );
    return proxy;
  }
  const client: Record<string, unknown> = {
    select: () => chain(),
    selectDistinct: () => chain(),
    insert: () => chain(),
    update: () => chain(),
    delete: () => chain(),
  };
  client.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(client);
  return { state, client };
});
vi.mock('@/lib/db', () => ({ getDb: () => fake.client }));

import { botCanAccessChannel, botReachesChannel, listBotChannels } from '../access';

const BOT = { id: 'bot-1', serverId: 'srv-1' };
const channel = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, serverId: 'srv-1', name: id, type: 'text', position: 0, pluginId: null, topic: null, createdAt: new Date(), ...overrides,
});

function script(...results: unknown[][]) {
  fake.state.results = results;
  fake.state.calls = 0;
}

beforeEach(() => script());

describe('botCanAccessChannel / listBotChannels (the real §1.1 rule)', () => {
  it('grant only #a, then #a is deleted: #general is NOT reachable and the bot lists no channel', async () => {
    // The grant row cascaded with #a; the bot row still says `selected`.
    script([channel('general')], [{ mode: 'selected', channelId: null }]);
    expect(await botCanAccessChannel(BOT, 'general')).toBeNull();
    script([{ mode: 'selected', channelId: null }]);
    expect(await listBotChannels(BOT)).toEqual([]);
  });

  it('while #a exists, exactly #a', async () => {
    script([channel('a')], [{ mode: 'selected', channelId: 'a' }]);
    expect((await botCanAccessChannel(BOT, 'a'))?.id).toBe('a');
    script([channel('general')], [{ mode: 'selected', channelId: 'a' }]);
    expect(await botCanAccessChannel(BOT, 'general')).toBeNull();
    script([{ mode: 'selected', channelId: 'a' }], [channel('a')]);
    expect((await listBotChannels(BOT)).map((c) => c.id)).toEqual(['a']);
  });

  it('mode all keeps the v1 rule: open channels yes, role-gated no', async () => {
    script([channel('general')], [{ mode: 'all', channelId: null }], []);
    expect((await botCanAccessChannel(BOT, 'general'))?.id).toBe('general');
    script([channel('staff')], [{ mode: 'all', channelId: null }], [{ id: 'override' }]);
    expect(await botCanAccessChannel(BOT, 'staff')).toBeNull();
  });
});

describe('botReachesChannel (fan-out / composer, from cached rows)', () => {
  it('selected: exactly the grants — none left = nothing, whatever the role gate says', () => {
    expect(botReachesChannel({ mode: 'selected', granted: [], channelId: 'general', openToBots: true })).toBe(false);
    expect(botReachesChannel({ mode: 'selected', granted: ['staff'], channelId: 'staff', openToBots: false })).toBe(true);
    expect(botReachesChannel({ mode: 'selected', granted: ['staff'], channelId: 'general', openToBots: true })).toBe(false);
  });

  it('all: open channels only (stray grant rows ignored)', () => {
    expect(botReachesChannel({ mode: 'all', granted: [], channelId: 'general', openToBots: true })).toBe(true);
    expect(botReachesChannel({ mode: 'all', granted: ['staff'], channelId: 'staff', openToBots: false })).toBe(false);
  });

  it('an unknown or missing mode is selected — never "all"', () => {
    expect(botReachesChannel({ mode: undefined, granted: [], channelId: 'general', openToBots: true })).toBe(false);
    expect(botReachesChannel({ mode: 'ALL', granted: [], channelId: 'general', openToBots: true })).toBe(false);
  });
});
