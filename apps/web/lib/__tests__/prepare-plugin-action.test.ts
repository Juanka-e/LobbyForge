import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@lobbyforge/db';

const { getCardPackById, listCardsForPack, listServerLocalCards } = vi.hoisted(() => ({
  getCardPackById: vi.fn(),
  listCardsForPack: vi.fn(),
  listServerLocalCards: vi.fn(),
}));

vi.mock('@lobbyforge/db', () => ({
  getCardPackById,
  listCardsForPack,
  listServerLocalCards,
}));

import { preparePluginAction } from '../prepare-plugin-action.js';

const db = {} as DbClient;

beforeEach(() => {
  getCardPackById.mockReset();
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
      action: { type: 'start-game', packId: 'pack-1', language: 'tr', deck: [{ word: 'evil' }] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.language).toBe('en');
    expect(result.action.deck).toEqual([
      expect.objectContaining({ id: 'card-1', word: 'apple', category: 'food-drink' }),
      expect.objectContaining({ id: 'local-1', word: 'LobbyForge', category: 'community' }),
    ]);
  });

  it('rejects a pack owned by another plugin', async () => {
    getCardPackById.mockResolvedValue({ id: 'pack-1', pluginId: 'quiz', language: 'en' });
    const result = await preparePluginAction(db, {
      pluginId: 'hushle', serverId: 'server-1', action: { type: 'start-game', packId: 'pack-1' },
    });
    expect(result).toEqual({ ok: false, status: 404, error: 'Card pack not found' });
    expect(listCardsForPack).not.toHaveBeenCalled();
  });
});
