import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextResponse } from 'next/server';

/**
 * NEW-008: route-level contract tests for the admin card-pack endpoint.
 * Pins the regressions found by the 3rd-party audit:
 *   - NEW-001: every action accepts its own discriminator (no blanket 400s)
 *   - NEW-002: pluginId is never taken from the body; hushle ownership is checked
 *   - NEW-003: update-card requires word + forbiddenWords TOGETHER
 *   - NEW-004: built-in packs/cards are immutable (409, not silent mutation)
 *   - NEW-005: ordinal race surfaces as 409, not 500
 */

const dbFns = {
  createCardPack: vi.fn(),
  addCardToPack: vi.fn(),
  deleteCardFromPack: vi.fn(),
  updateCardInPack: vi.fn(),
  listCardPackSummaries: vi.fn(),
  listCardsForPack: vi.fn(),
  getCardPackById: vi.fn(),
  getCardById: vi.fn(),
  deleteCardPack: vi.fn(),
  logAction: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@lobbyforge/db', () => dbFns);

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

vi.mock('@/lib/db', () => ({
  getDb: () => ({ __mockDbClient: true }),
}));

vi.mock('@/lib/plugin-content-seeder', () => ({
  ensureBuiltInContentSeeded: vi.fn(async () => undefined),
}));

const requireInstanceAdmin = vi.fn();
vi.mock('@/lib/admin-auth', () => ({
  requireInstanceAdmin: (...args: unknown[]) => requireInstanceAdmin(...args),
}));

const UUID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';

function pack(overrides: Record<string, unknown> = {}) {
  return {
    id: UUID,
    pluginId: 'hushle',
    slug: 'hushle-en-basic',
    name: 'English (Basic)',
    language: 'en',
    description: null,
    isBuiltIn: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    packId: UUID,
    ordinal: 0,
    payload: { word: 'apple', forbiddenWords: ['fruit'] },
    difficulty: 'easy',
    category: 'general',
    createdAt: new Date(),
    ...overrides,
  };
}

async function post(body: unknown): Promise<Response> {
  const { POST } = await import('../route.js');
  const handler = POST as unknown as (req: Request) => Promise<NextResponse>;
  return handler(
    new Request('http://localhost/api/admin/card-packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  for (const fn of Object.values(dbFns)) fn.mockReset();
  dbFns.logAction.mockResolvedValue(undefined);
  requireInstanceAdmin.mockReset().mockResolvedValue(null);
  // Default: an editable custom hushle pack exists.
  dbFns.getCardPackById.mockResolvedValue(pack());
  dbFns.getCardById.mockResolvedValue(card());
  dbFns.listCardsForPack.mockResolvedValue([]);
});

describe('POST /api/admin/card-packs', () => {
  it('rejects unauthenticated callers with 401', async () => {
    requireInstanceAdmin.mockResolvedValue(
      Response.json({ error: 'Instance owner authentication required' }, { status: 401 })
    );
    const res = await post({ action: 'create-pack', name: 'X', language: 'de' });
    expect(res.status).toBe(401);
    expect(dbFns.createCardPack).not.toHaveBeenCalled();
  });

  it('creates a pack (action discriminator accepted, pluginId pinned to hushle)', async () => {
    dbFns.createCardPack.mockResolvedValue(pack({ isBuiltIn: false }));
    const res = await post({ action: 'create-pack', name: 'Deutsch', language: 'de' });
    expect(res.status).toBe(201);
    expect(dbFns.createCardPack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pluginId: 'hushle', language: 'de' })
    );
  });

  it('rejects a pluginId supplied by the client (strict schema, NEW-002)', async () => {
    const res = await post({ action: 'create-pack', name: 'X', language: 'de', pluginId: 'quiz' });
    expect(res.status).toBe(400);
    expect(dbFns.createCardPack).not.toHaveBeenCalled();
  });

  it('rejects a malformed language tag (NEW-006, server-side)', async () => {
    const res = await post({ action: 'create-pack', name: 'X', language: 'not a lang!' });
    expect(res.status).toBe(400);
    expect(dbFns.createCardPack).not.toHaveBeenCalled();
  });

  it('rejects an unknown action with 400', async () => {
    const res = await post({ action: 'explode-everything' });
    expect(res.status).toBe(400);
  });

  it('add-card: 404 when the pack belongs to another plugin (NEW-002)', async () => {
    dbFns.getCardPackById.mockResolvedValue(pack({ pluginId: 'quiz' }));
    const res = await post({
      action: 'add-card',
      packId: UUID,
      word: 'w',
      forbiddenWords: ['f'],
      difficulty: 'easy',
      category: 'general',
    });
    expect(res.status).toBe(404);
    expect(dbFns.addCardToPack).not.toHaveBeenCalled();
  });

  it('update-card: 400 when forbiddenWords is missing (NEW-003)', async () => {
    const res = await post({ action: 'update-card', cardId: UUID, word: 'solo' });
    expect(res.status).toBe(400);
    expect(dbFns.updateCardInPack).not.toHaveBeenCalled();
  });

  it('update-card: 404 when the card does not exist', async () => {
    dbFns.getCardById.mockResolvedValue(null);
    const res = await post({
      action: 'update-card',
      cardId: UUID,
      word: 'w',
      forbiddenWords: ['f'],
    });
    expect(res.status).toBe(404);
  });

  it('update-card: 409 on a built-in pack (NEW-004 immutability)', async () => {
    dbFns.getCardPackById.mockResolvedValue(pack({ isBuiltIn: true }));
    const res = await post({
      action: 'update-card',
      cardId: UUID,
      word: 'w',
      forbiddenWords: ['f'],
      difficulty: 'hard',
    });
    expect(res.status).toBe(409);
    expect(dbFns.updateCardInPack).not.toHaveBeenCalled();
  });

  it('delete-card: 409 on a built-in pack, ok on a custom pack', async () => {
    dbFns.getCardPackById.mockResolvedValue(pack({ isBuiltIn: true }));
    const refused = await post({ action: 'delete-card', cardId: UUID });
    expect(refused.status).toBe(409);

    dbFns.getCardPackById.mockResolvedValue(pack({ isBuiltIn: false }));
    dbFns.deleteCardFromPack.mockResolvedValue(true);
    const allowed = await post({ action: 'delete-card', cardId: UUID });
    expect(allowed.status).toBe(200);
    expect(dbFns.deleteCardFromPack).toHaveBeenCalled();
  });

  it('delete-pack: 409 on built-in, 200 on custom', async () => {
    dbFns.getCardPackById.mockResolvedValue(pack({ isBuiltIn: true }));
    expect((await post({ action: 'delete-pack', packId: UUID })).status).toBe(409);

    dbFns.getCardPackById.mockResolvedValue(pack({ isBuiltIn: false }));
    dbFns.deleteCardPack.mockResolvedValue(true);
    const res = await post({ action: 'delete-pack', packId: UUID });
    expect(res.status).toBe(200);
    expect(dbFns.deleteCardPack).toHaveBeenCalled();
  });

  it('duplicate-pack: copies every card into a fresh custom pack', async () => {
    dbFns.getCardPackById.mockResolvedValue(pack({ isBuiltIn: true }));
    dbFns.createCardPack.mockResolvedValue(pack({ slug: 'hushle-en-abc12345', isBuiltIn: false }));
    dbFns.listCardsForPack.mockResolvedValue([card(), card({ ordinal: 1, payload: { word: 'train', forbiddenWords: ['rail'] } })]);

    const res = await post({ action: 'duplicate-pack', packId: UUID });
    expect(res.status).toBe(201);
    expect(dbFns.createCardPack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isBuiltIn: false })
    );
    expect(dbFns.addCardToPack).toHaveBeenCalledTimes(2);
  });

  it('add-card: retries the ordinal on unique-violation, 409 when the race persists (NEW-005)', async () => {
    dbFns.listCardsForPack.mockResolvedValue([]);
    const violation = new Error('duplicate key value violates unique constraint "cards_pack_id_ordinal_unique"');
    dbFns.addCardToPack
      .mockRejectedValueOnce(violation)
      .mockRejectedValueOnce(violation)
      .mockRejectedValueOnce(violation);

    const res = await post({
      action: 'add-card',
      packId: UUID,
      word: 'w',
      forbiddenWords: ['f'],
      difficulty: 'easy',
      category: 'general',
    });
    expect(res.status).toBe(409);
    expect(dbFns.addCardToPack).toHaveBeenCalledTimes(3);
    expect(dbFns.listCardsForPack).toHaveBeenCalledTimes(3);
  });
});
