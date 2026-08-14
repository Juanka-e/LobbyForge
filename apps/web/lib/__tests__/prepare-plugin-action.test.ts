import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@lobbyforge/db';

const { getCardPackById, getCardPackBySlug, listCardsForPack, listServerLocalCards } = vi.hoisted(() => ({
  getCardPackById: vi.fn(),
  getCardPackBySlug: vi.fn(),
  listCardsForPack: vi.fn(),
  listServerLocalCards: vi.fn(),
}));

vi.mock('@lobbyforge/db', () => ({
  getCardPackById,
  getCardPackBySlug,
  listCardsForPack,
  listServerLocalCards,
}));

import { preparePluginAction } from '../prepare-plugin-action.js';

const db = {} as DbClient;

beforeEach(() => {
  getCardPackById.mockReset();
  getCardPackBySlug.mockReset();
  listCardsForPack.mockReset();
  listServerLocalCards.mockReset();
});

describe('preparePluginAction', () => {
  it('overwrites client deck data with validated database cards', async () => {
    getCardPackById.mockResolvedValue({ id: 'pack-1', pluginId: 'hushle', language: 'en' });
    listCardsForPack.mockResolvedValue([{
      id: 'card-1', payload: { word: 'apple', forbiddenWords: ['fruit'] },
      difficulty: 'easy', category: 'food-drink',
    }]);
    listServerLocalCards.mockResolvedValue([{
      id: 'local-1', payload: { word: 'LobbyForge', forbiddenWords: ['voice'] },
      difficulty: 'hard', category: 'community',
    }]);

    const result = await preparePluginAction(db, {
      pluginId: 'hushle',
      serverId: 'server-1',
      action: {
        type: 'start-game',
        packId: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9',
        language: 'tr',
        deck: [{ word: 'evil' }],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.language).toBe('en');
    expect(result.action.deck).toEqual([
      expect.objectContaining({ id: 'card-1', word: 'apple', category: 'food-drink' }),
      expect.objectContaining({ id: 'local-1', word: 'LobbyForge', category: 'community' }),
    ]);
  });

  it('resolves the pack by slug when the client sends a pack slug (host UI flow)', async () => {
    // The host UI's pack selector dispatches the pack's slug, not its UUID.
    getCardPackBySlug.mockResolvedValue({ id: 'pack-1', pluginId: 'hushle', language: 'tr' });
    getCardPackById.mockResolvedValue(null);
    listCardsForPack.mockResolvedValue([{
      id: 'card-1', payload: { word: 'elma', forbiddenWords: ['meyve'] },
      difficulty: 'easy', category: 'food-drink',
    }]);
    listServerLocalCards.mockResolvedValue([]);

    const result = await preparePluginAction(db, {
      pluginId: 'hushle',
      serverId: 'server-1',
      action: { type: 'start-game', packId: 'hushle-tr-basic', language: 'en' },
    });

    expect(getCardPackBySlug).toHaveBeenCalledWith(db, 'hushle', 'hushle-tr-basic');
    expect(getCardPackById).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The DB pack's language wins over whatever the client claimed.
    expect(result.action.language).toBe('tr');
    expect(result.action.packId).toBe('hushle-tr-basic');
    expect(result.action.deck).toEqual([
      expect.objectContaining({ id: 'card-1', word: 'elma', language: 'tr' }),
    ]);
  });

  it('passes a custom-language pack through (M20b: hosts can seed any language)', async () => {
    getCardPackBySlug.mockResolvedValue({ id: 'pack-de', pluginId: 'hushle', language: 'de' });
    listCardsForPack.mockResolvedValue([{
      id: 'card-de-1', payload: { word: 'Apfel', forbiddenWords: ['Obst'] },
      difficulty: 'medium', category: 'general',
    }]);
    listServerLocalCards.mockResolvedValue([]);

    const result = await preparePluginAction(db, {
      pluginId: 'hushle',
      serverId: 'server-1',
      action: { type: 'start-game', packId: 'hushle-de-custom' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.language).toBe('de');
    expect(result.action.deck).toEqual([
      expect.objectContaining({ word: 'Apfel', language: 'de', difficulty: 'medium' }),
    ]);
  });

  it('rejects a malformed pack language tag', async () => {
    getCardPackBySlug.mockResolvedValue({ id: 'pack-x', pluginId: 'hushle', language: 'not a lang!' });
    const result = await preparePluginAction(db, {
      pluginId: 'hushle', serverId: 'server-1', action: { type: 'start-game', packId: 'weird-pack' },
    });
    expect(result).toEqual({ ok: false, status: 409, error: 'Card pack language is malformed' });
  });

  it('rejects a pack owned by another plugin', async () => {
    getCardPackById.mockResolvedValue({ id: 'pack-1', pluginId: 'quiz', language: 'en' });
    const result = await preparePluginAction(db, {
      pluginId: 'hushle', serverId: 'server-1',
      action: { type: 'start-game', packId: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9' },
    });
    expect(result).toEqual({ ok: false, status: 404, error: 'Card pack not found' });
    expect(listCardsForPack).not.toHaveBeenCalled();
  });
});
