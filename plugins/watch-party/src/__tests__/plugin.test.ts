import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_SUMMARY_KEY, registerGamePlugin, tFor } from '@lobbyforge/plugin-sdk';
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';
import {
  WATCH_PARTY_ACTION_TYPES,
  WATCH_PARTY_PLUGIN_ID,
  watchPartyPlugin,
  type WatchPartyAction,
  type WatchPartyState,
} from '../index';

const SERVER_T0 = Date.UTC(2026, 8, 28, 20, 0, 0);

describe('manifest', () => {
  const { manifest } = watchPartyPlugin;

  it('is an official activity that ships its languages and a translated summary', () => {
    expect(manifest.id).toBe(WATCH_PARTY_PLUGIN_ID);
    expect(manifest.id).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(manifest.type).toBe('activity');
    expect(manifest.locales).toEqual(['en', 'tr']);
    expect(manifest.catalog?.category).toBe('integration');
    expect(manifest.catalog?.trustLevel).toBe('official');
    expect(manifest.catalog?.requiresVoiceRoom).toBe(true);
    expect(manifest.catalog?.summary).toBe(tFor(WATCH_PARTY_PLUGIN_ID, 'en', CATALOG_SUMMARY_KEY));
    expect(tFor(WATCH_PARTY_PLUGIN_ID, 'tr', CATALOG_SUMMARY_KEY)).not.toBe(manifest.catalog?.summary);
  });

  it('asks for no more than it uses', () => {
    expect(manifest.permissions).toEqual(['manage_game_session']);
  });
});

describe('action policies', () => {
  it('names the actor on every action through actorFields', () => {
    const policies = watchPartyPlugin.actionPolicies!;
    expect(Object.keys(policies).sort()).toEqual([...WATCH_PARTY_ACTION_TYPES].sort());
    for (const type of WATCH_PARTY_ACTION_TYPES) {
      expect(policies[type]?.actorFields, type).toEqual(['actorId']);
    }
  });

  it('decides host rights in the reducer (member), except take-host (creator + moderators)', () => {
    const policies = watchPartyPlugin.actionPolicies!;
    for (const type of WATCH_PARTY_ACTION_TYPES) {
      expect(policies[type]?.role, type).toBe(type === 'take-host' ? 'host' : 'member');
    }
  });

  it('watching needs the voice room; only leaving works from outside it', () => {
    const policies = watchPartyPlugin.actionPolicies!;
    for (const type of WATCH_PARTY_ACTION_TYPES) {
      expect(policies[type]?.allowOutsideVoice === true, type).toBe(type === 'leave');
    }
  });

  it('validates the normalized action the host builds', () => {
    expect(watchPartyPlugin.validateAction?.({ type: 'queue-add', actorId: 'u1', url: 'https://youtu.be/aaaaaaaaaaa' })).toBeNull();
    expect(watchPartyPlugin.validateAction?.({ type: 'queue-add', actorId: 'u1', url: 'https://vimeo.com/1' })).toMatch(/YouTube/);
  });
});

describe('through the SDK test harness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness() {
    return createTestHarness<WatchPartyState, WatchPartyAction>({
      plugin: watchPartyPlugin,
      players: ['host', 'ana', 'bo'],
    });
  }
  /** What a browser sends: no actorId — the host adds it. */
  const send = (h: ReturnType<typeof harness>, userId: string, action: Record<string, unknown>) =>
    h.performAction(userId, action as WatchPartyAction);

  it('starts with the creator hosting, stamped with the server clock', async () => {
    const h = harness();
    await h.startGame();
    expect(h.getState()).toMatchObject({ hostId: 'host', hostSince: SERVER_T0, stampedAt: SERVER_T0, current: null });
    expect(h.getState().viewers.map((v) => v.userId)).toEqual(['host']);
  });

  it('plays a short session end to end', async () => {
    const h = harness();
    await h.startGame();
    await send(h, 'ana', { type: 'join' });
    await send(h, 'bo', { type: 'join' });
    await send(h, 'host', { type: 'set-video', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' });
    await send(h, 'ana', { type: 'queue-add', url: 'https://youtu.be/bbbbbbbbbbb' });
    expect(h.getState().current?.videoId).toBe('aaaaaaaaaaa');
    expect(h.getState().queue.map((i) => i.addedBy)).toEqual(['ana']);

    vi.setSystemTime(SERVER_T0 + 5_000);
    await send(h, 'host', { type: 'play' });
    // The timeline is stamped with the SERVER's clock, never a client's.
    expect(h.getState().playback).toEqual({ status: 'playing', positionSec: 0, updatedAt: SERVER_T0 + 5_000 });

    vi.setSystemTime(SERVER_T0 + 65_000);
    await send(h, 'host', { type: 'pause' });
    expect(h.getState().playback).toEqual({ status: 'paused', positionSec: 60, updatedAt: SERVER_T0 + 65_000 });

    // Ana may not control until the host allows everyone.
    await send(h, 'ana', { type: 'play' });
    expect(h.getState().playback.status).toBe('paused');
    await send(h, 'host', { type: 'set-control-mode', mode: 'everyone' });
    await send(h, 'ana', { type: 'play' });
    expect(h.getState().playback.status).toBe('playing');

    // The host leaves; the longest-present viewer takes over and skips on.
    await send(h, 'host', { type: 'leave' });
    expect(h.getState().hostId).toBe('ana');
    await send(h, 'ana', { type: 'skip' });
    expect(h.getState().current?.videoId).toBe('bbbbbbbbbbb');
    expect(h.getState().queue).toEqual([]);
  });

  it('takes the actor from the host context, never from the action body', async () => {
    const h = harness();
    await h.startGame();
    await send(h, 'ana', { type: 'join' });
    // Ana claims to be the host in the body — the context says Ana.
    await send(h, 'ana', { type: 'set-video', url: 'https://youtu.be/aaaaaaaaaaa', actorId: 'host' });
    expect(h.getState().current).toBeNull();
  });

  it('never throws on junk', async () => {
    const h = harness();
    await h.startGame();
    const before = h.getState();
    for (const junk of [{ type: 'seek', positionSec: 'soon' }, { type: 'nope' }, {}, { type: 'queue-add', url: {} }]) {
      await send(h, 'host', junk);
    }
    expect(h.getState()).toBe(before);
  });

  it('upgrades a damaged stored state before reducing it', () => {
    const next = watchPartyPlugin.handleAction(
      { actorUserId: 'ana' } as never,
      { garbage: true } as never,
      { type: 'join', actorId: 'ana' }
    );
    expect(next.version).toBe(1);
    expect(next.hostId).toBe('ana');
  });

  it('migrates on read, idempotently', () => {
    const once = watchPartyPlugin.migrateState!({ videoId: 'aaaaaaaaaaa', hostId: 'host', participants: ['host'] });
    expect(watchPartyPlugin.migrateState!(once)).toEqual(once);
  });

  it('registers with the host catalogue', () => {
    const registered = registerGamePlugin(watchPartyPlugin);
    expect(registered.manifest.id).toBe(WATCH_PARTY_PLUGIN_ID);
    expect(registered.migrateState).toBeTypeOf('function');
    expect(registered.validateAction).toBeTypeOf('function');
  });
});
