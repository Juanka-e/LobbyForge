import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { CATALOG_SUMMARY_KEY, registerGamePlugin, tFor } from '@lobbyforge/plugin-sdk';
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';
import {
  VAMPIRE_VILLAGE_PLUGIN_ID,
  VV_STATE_VERSION,
  createVillageInitialState,
  migrateVillageState,
  vampireVillagePlugin,
  type VillageAction,
  type VillageState,
} from '../index';
import { LOCALE_TABLES, SHIPPED_LOCALES } from '../locales.generated';

const ACTION_TYPES: Array<VillageAction['type']> = [
  'join',
  'leave',
  'set-ready',
  'configure',
  'start',
  'kick',
  'advance',
  'timeout',
  'pause',
  'resume',
  'extend',
  'night-target',
  'night-shield',
  'vote',
  'chat',
  'pack-chat',
  'play-again',
  'end-game',
];

describe('manifest', () => {
  const { manifest } = vampireVillagePlugin;

  it('is the vampire game — no werewolves left', () => {
    expect(manifest.id).toBe('vampire-village');
    expect(VAMPIRE_VILLAGE_PLUGIN_ID).toBe('vampire-village');
    expect(manifest.name).toBe('Vampire Village');
    expect(JSON.stringify(manifest).toLowerCase()).not.toContain('werewolf');
  });

  it('ships its locales and a translated catalogue summary', () => {
    expect(manifest.locales).toEqual(SHIPPED_LOCALES);
    expect(manifest.locales).toEqual(expect.arrayContaining(['en', 'tr']));
    expect(manifest.catalog?.summary).toBe(LOCALE_TABLES.en[CATALOG_SUMMARY_KEY]);
    expect(tFor(VAMPIRE_VILLAGE_PLUGIN_ID, 'tr', CATALOG_SUMMARY_KEY)).toBe(LOCALE_TABLES.tr[CATALOG_SUMMARY_KEY]);
  });

  it('declares the spec player range and a voice room', () => {
    expect(manifest.catalog?.playerConfig).toEqual({
      minPlayers: 5,
      maxPlayers: 12,
      defaultMaxPlayers: 12,
      supportsSpectators: true,
      supportsQueue: false,
      overflowPolicy: 'spectator',
    });
    expect(manifest.catalog?.requiresVoiceRoom).toBe(true);
    expect(manifest.catalog?.category).toBe('game');
    expect(manifest.catalog?.trustLevel).toBe('official');
  });
});

describe('action policies', () => {
  const policies = vampireVillagePlugin.actionPolicies!;

  it('covers every action type', () => {
    expect(Object.keys(policies).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it('keeps the table controls with the host', () => {
    for (const type of ['configure', 'start', 'kick', 'advance', 'pause', 'resume', 'extend', 'play-again', 'end-game']) {
      expect(policies[type], type).toEqual({ role: 'host' });
    }
  });

  it('lets any member act as themselves — the host stamps playerId from the session', () => {
    // Only joining puts a player on the public roster — never a night
    // action or a vote, whose author must stay hidden.
    expect(policies.join).toEqual({ role: 'member', actorFields: ['playerId'], joinsRoster: true });
    for (const type of ['set-ready', 'timeout', 'night-target', 'night-shield', 'vote', 'chat', 'pack-chat']) {
      expect(policies[type], type).toEqual({ role: 'member', actorFields: ['playerId'] });
    }
    // Playing needs the voice room (requiresVoiceRoom); leaving works from outside it.
    expect(policies.leave).toEqual({ role: 'member', actorFields: ['playerId'], allowOutsideVoice: true });
  });
});

describe('state versioning', () => {
  it('passes a current state through untouched (idempotent)', () => {
    const s = createVillageInitialState();
    expect(migrateVillageState(s)).toBe(s);
    expect(migrateVillageState(migrateVillageState(s))).toBe(s);
  });

  it('replaces anything unreadable — including the old werewolf stub — with a fresh lobby', () => {
    const legacy = {
      phase: 'setup',
      round: 0,
      players: [{ id: 'u1', name: 'A', role: 'werewolf', alive: true }],
      votes: {},
      lastEliminatedId: null,
    };
    for (const raw of [null, 'x', 7, [], legacy, { version: 99, phase: 'night' }]) {
      const out = migrateVillageState(raw);
      expect(out.version).toBe(VV_STATE_VERSION);
      expect(out.phase).toBe('lobby');
      expect(out.players).toEqual([]);
    }
  });
});

describe('the GamePlugin contract', () => {
  it('plays through the SDK harness with the actor stamped as the host would', async () => {
    const players = ['u1', 'u2', 'u3', 'u4', 'u5'];
    const harness = createTestHarness<VillageState, VillageAction>({ plugin: vampireVillagePlugin, players });
    await harness.startGame();
    for (const [i, id] of players.entries()) {
      await harness.performAction(id, { type: 'join', playerId: id, name: `Villager ${i + 1}` });
      await harness.performAction(id, { type: 'set-ready', playerId: id, ready: true });
    }
    await harness.performAction('u1', { type: 'start' });
    const state = harness.getState();
    expect(state.phase).toBe('role_reveal');
    expect(Object.keys(state.secret.roles).sort()).toEqual(players);
    expect(Object.values(state.secret.roles).filter((r) => r === 'vampire')).toHaveLength(1);
  });

  it('exposes validateAction through the registry adapter', () => {
    const registered = registerGamePlugin(vampireVillagePlugin);
    expect(registered.validateAction?.({ type: 'start' })).toBeNull();
    expect(registered.validateAction?.({ type: 'nope' })).toEqual(expect.any(String));
    expect(registered.migrateState?.(null)).toMatchObject({ phase: 'lobby' });
  });

  it('never throws from handleAction', () => {
    const state = createVillageInitialState();
    for (const action of [null, {}, { type: 'vote' }, { type: 'join', playerId: {}, name: [] }]) {
      expect(() => vampireVillagePlugin.handleAction(null as never, state, action as never)).not.toThrow();
    }
  });

  it('returns a React element from renderClient instead of calling the panel', () => {
    const out = vampireVillagePlugin.renderClient({
      state: createVillageInitialState(),
      dispatch: () => {},
      actorUserId: 'u1',
      hostUserId: 'u1',
      players: [{ userId: 'u1', name: 'Host' }],
    } as never);
    expect(isValidElement(out)).toBe(true);
  });
});
